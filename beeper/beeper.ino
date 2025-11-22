#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <esp_wifi.h>
#include <Audio.h>

// ---------- Cloud configuration ----------
const char *backendBaseUrl = "https://beeper-ps1z.onrender.com";
const char *claimEndpointPath = "/api/device/claim";
const char *pollEndpointPath = "/api/device/status";

const unsigned long pollIntervalMs = 3000;
const unsigned long wifiConnectTimeoutMs = 20000;

// ---------- Hardware ----------
const int buzzerPin = 4;       // GPIO4
const int resetButtonPin = 14; // GPIO14; connect to GND when pressed

// I2S pins for MAX98357A amplifier
const int I2S_BCLK = 15;   // BCLK
const int I2S_LRC = 16;    // LRCK (WS)
const int I2S_DIN = 17;    // DIN (SD)

// ---------- Beep pattern definitions ----------
struct BeepPattern {
  const char* name;
  const int (*pattern)[2];
  int patternLength;
  int cycles;
  int cyclePause;
};

// Pattern: Classic Alert (original pattern)
const int classicAlertPattern[][2] = {
    {120, 80}, {120, 80}, {120, 160}, // opening triple beep
    {40, 60},  {40, 60},  {40, 200},  // quick chirps
    {300, 70}, {300, 70},             // two strong pulses
    {600, 400}                        // lingering finish
};

// Pattern: Short Ping
const int shortPingPattern[][2] = {
    {100, 100}, {100, 100}, {100, 300}
};

// Pattern: Double Buzz
const int doubleBuzzPattern[][2] = {
    {250, 100}, {250, 300}
};

// Pattern: Rising Alert
const int risingAlertPattern[][2] = {
    {100, 50}, {200, 50}, {300, 50}, {400, 200}
};

// Pattern: Morse SOS
const int morseSosPattern[][2] = {
    {100, 50}, {100, 50}, {100, 150},   // S (dot-dot-dot)
    {300, 50}, {300, 50}, {300, 150},   // O (dash-dash-dash)
    {100, 50}, {100, 50}, {100, 300}    // S (dot-dot-dot)
};

// Pattern: Gentle Chime
const int gentleChimePattern[][2] = {
    {50, 100}, {75, 100}, {100, 300}
};

// Pattern: Rapid Fire
const int rapidFirePattern[][2] = {
    {50, 50}, {50, 50}, {50, 50}, {50, 50}, {50, 50}, {50, 300}
};

// Array of available patterns
const BeepPattern patterns[] = {
    {"Classic Alert", classicAlertPattern, sizeof(classicAlertPattern) / sizeof(classicAlertPattern[0]), 3, 300},
    {"Short Ping", shortPingPattern, sizeof(shortPingPattern) / sizeof(shortPingPattern[0]), 2, 200},
    {"Double Buzz", doubleBuzzPattern, sizeof(doubleBuzzPattern) / sizeof(doubleBuzzPattern[0]), 3, 250},
    {"Rising Alert", risingAlertPattern, sizeof(risingAlertPattern) / sizeof(risingAlertPattern[0]), 2, 200},
    {"Morse SOS", morseSosPattern, sizeof(morseSosPattern) / sizeof(morseSosPattern[0]), 1, 0},
    {"Gentle Chime", gentleChimePattern, sizeof(gentleChimePattern) / sizeof(gentleChimePattern[0]), 2, 150},
    {"Rapid Fire", rapidFirePattern, sizeof(rapidFirePattern) / sizeof(rapidFirePattern[0]), 1, 0}
};

const int patternsCount = sizeof(patterns) / sizeof(patterns[0]);

// ---------- Globals ----------
Preferences prefs;
// Use pointers to avoid early construction issues on S3
WebServer *configServer = nullptr;
DNSServer *dnsServer = nullptr;
Audio audio;  // I2S audio output for MAX98357A

const byte dnsPort = 53;
IPAddress apIp(192, 168, 4, 1);
IPAddress apNetmask(255, 255, 255, 0);

String deviceId;
String wifiSsid;
String wifiPassword;
String claimCode;
String pollSecret;
String webhookUrl;
int selectedPattern = 0; // Index of selected pattern, default to Classic Alert

bool configMode = false;
bool shouldRestart = false;
unsigned long restartRequestTime = 0;
unsigned long lastPoll = 0;
unsigned long resetPressStart = 0;
bool resetTriggerArmed = false;
const unsigned long restartDelayMs = 30000; // 30 seconds delay before restart
int consecutivePollErrors = 0;
const int maxPollErrors = 5; // After 5 consecutive 401 errors, force re-claim

// ---------- Helper ----------
String sanitizedMac() {
  uint8_t mac[6] = {0};

  // Try to get MAC address from WiFi
  esp_err_t result = esp_wifi_get_mac(WIFI_IF_STA, mac);

  // If WiFi isn't initialized yet, try AP mode or use random fallback
  if (result != ESP_OK) {
    Serial.print("[WARN] Failed to get MAC from STA, trying AP mode...");
    result = esp_wifi_get_mac(WIFI_IF_AP, mac);
    if (result != ESP_OK) {
      Serial.println(" Failed");
      return ""; // Return empty, caller will handle fallback
    }
    Serial.println(" OK (from AP)");
  }

  char buffer[13];
  snprintf(buffer, sizeof(buffer), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1],
           mac[2], mac[3], mac[4], mac[5]);

  return String(buffer);
}

void loadStoredConfig() {
  wifiSsid = prefs.getString("wifi_ssid", "");
  wifiPassword = prefs.getString("wifi_pass", "");
  claimCode = prefs.getString("claim_code", "");
  pollSecret = prefs.getString("poll_secret", "");
  webhookUrl = prefs.getString("webhook_url", "");
  selectedPattern = prefs.getInt("pattern_id", 0); // Default to Classic Alert (index 0)

  // Validate pattern index
  if (selectedPattern < 0 || selectedPattern >= patternsCount) {
    selectedPattern = 0;
  }
}

void saveWifiConfig(const String &ssid, const String &pass,
                    const String &claim) {
  prefs.putString("wifi_ssid", ssid);
  prefs.putString("wifi_pass", pass);
  prefs.putString("claim_code", claim);
  wifiSsid = ssid;
  wifiPassword = pass;
  claimCode = claim;
}

void saveClaimData(const String &secret, const String &webhook) {
  pollSecret = secret;
  webhookUrl = webhook;
  prefs.putString("poll_secret", secret);
  prefs.putString("webhook_url", webhook);
  // Keep claim_code stored so device can re-claim if needed (e.g., after DB
  // migration) prefs.remove("claim_code"); // Removed - keep for potential
  // re-claim
}

void saveSelectedPattern(int patternId) {
  if (patternId >= 0 && patternId < patternsCount) {
    selectedPattern = patternId;
    prefs.putInt("pattern_id", patternId);
    Serial.print("Pattern changed to: ");
    Serial.println(patterns[selectedPattern].name);
  }
}

void clearStoredConfig() {
  prefs.remove("wifi_ssid");
  prefs.remove("wifi_pass");
  prefs.remove("poll_secret");
  prefs.remove("claim_code");
  prefs.remove("webhook_url");
  prefs.remove("pattern_id");

  wifiSsid = "";
  wifiPassword = "";
  pollSecret = "";
  claimCode = "";
  webhookUrl = "";
  selectedPattern = 0;
}

bool connectToWiFi() {
  if (wifiSsid.isEmpty()) {
    return false;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());

  Serial.print("Connecting to Wi-Fi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - start < wifiConnectTimeoutMs) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected. IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("Failed to connect within timeout.");
  return false;
}

void sendConfigForm() {
  String ssidValue = wifiSsid;
  ssidValue.replace("'", "&#39;");
  String claimValue = claimCode;
  claimValue.replace("'", "&#39;");
  claimValue
      .toUpperCase(); // Convert to uppercase before using in concatenation
  String claimLookupBase = String(backendBaseUrl) + "/link";
  String claimLookupUrl = claimLookupBase;
  if (!claimCode.isEmpty()) {
    claimLookupUrl += "?claim=" + claimCode;
  }
  String safeDeviceId = deviceId;
  safeDeviceId.replace("&", "&amp;");
  safeDeviceId.replace("<", "&lt;");
  safeDeviceId.replace(">", "&gt;");
  safeDeviceId.replace("'", "&#39;");
  bool hasClaimData = !pollSecret.isEmpty() && !webhookUrl.isEmpty();
  String lookupDisplay = claimCode.isEmpty() ? claimLookupBase : claimLookupUrl;
  String safeLookupDisplay = lookupDisplay;
  safeLookupDisplay.replace("&", "&amp;");
  safeLookupDisplay.replace("<", "&lt;");
  safeLookupDisplay.replace(">", "&gt;");
  safeLookupDisplay.replace("\"", "&quot;");
  safeLookupDisplay.replace("'", "&#39;");

  String claimSection;
  if (hasClaimData) {
    claimSection = "<section class='card success'>"
                   "<h2>Device Linked</h2>"
                   "<p>Your Beeper is already paired with the Beeper cloud. If "
                   "you need the webhook credentials again, use the claim "
                   "lookup link below from any browser.</p>"
                   "</section>";
  } else {
    claimSection =
        "<section class='card muted'>"
        "<h2>Next Steps</h2>"
        "<p>After you tap <strong>Save & Reboot</strong>, the Beeper will join "
        "your Wi-Fi and register itself with the cloud. Use the lookup link to "
        "retrieve the webhook URL, poll secret, and curl command.</p>"
        "<p class='tip'>If pairing fails, hold the hardware button for 3 "
        "seconds to return to setup mode and try again.</p>"
        "</section>";
  }

  String form =
      "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' "
      "content='width=device-width, initial-scale=1'>"
      "<title>Beeper Setup</title>"
      "<style>"
      "*,*::before,*::after{box-sizing:border-box;}body{margin:0;font-family:'"
      "Segoe UI',Tahoma,sans-serif;"
      "background:linear-gradient(135deg,#060f24,#0b1f3f);color:#0b1320;min-"
      "height:100vh;display:flex;align-items:center;"
      "justify-content:center;padding:2.5rem;}h1,h2{margin:0;color:#0b1f3f;}p{"
      "color:#3a4661;line-height:1.5;}"
      "code{background:#f5f7fb;border-radius:0.5rem;padding:0.75rem "
      "1rem;display:block;word-break:break-all;"
      "font-size:0.95rem;color:#14213d;margin-bottom:0.75rem;}"
      ".container{max-width:760px;width:100%;display:grid;gap:1.75rem;}"
      ".top-card{background:#ffffff;border-radius:1.25rem;padding:2.5rem "
      "2.75rem;"
      "box-shadow:0 35px 50px rgba(8,18,46,0.35);border:1px solid "
      "rgba(255,255,255,0.35);}"
      ".lead{margin-top:0.75rem;margin-bottom:2rem;color:#4b5877;}"
      "form{display:grid;gap:1.25rem;margin-top:1.75rem;}"
      "label{display:block;font-weight:600;color:#111d2f;}"
      "input{width:100%;margin-top:0.5rem;padding:0.85rem "
      "1rem;border-radius:0.8rem;border:1px solid #d5dbe8;"
      "font-size:1rem;background:#f4f6fb;transition:border-color "
      ".2s,box-shadow .2s;}"
      "input:focus{outline:none;border-color:#3d7dff;box-shadow:0 0 0 4px "
      "rgba(61,125,255,0.15);}"
      ".submit-btn{margin-top:0.5rem;padding:0.95rem "
      "1.25rem;border:none;border-radius:1rem;background:#3564ff;"
      "color:#ffffff;font-weight:700;font-size:1.05rem;cursor:pointer;"
      "transition:transform .2s,box-shadow .2s;"
      "box-shadow:0 18px 30px rgba(53,100,255,0.3);} "
      ".submit-btn:hover{transform:translateY(-2px);"
      "box-shadow:0 22px 35px rgba(53,100,255,0.4);} .section{margin-top:2rem;}"
      ".card{background:#ffffff;border-radius:1.25rem;padding:2rem "
      "2.5rem;box-shadow:0 30px 45px rgba(8,18,46,0.3);"
      "border:1px solid rgba(255,255,255,0.4);}"
      ".card.success{border:1px solid rgba(49,155,89,0.35);} "
      ".card.muted{background:rgba(255,255,255,0.82);"
      "border:1px dashed rgba(57,77,109,0.4);} .info-block{margin-top:1.5rem;}"
      ".info-header{font-weight:700;font-size:0.95rem;text-transform:uppercase;"
      "letter-spacing:0.08em;color:#3d527d;"
      "margin-bottom:0.75rem;}"
      ".info-body{display:flex;flex-direction:column;gap:0.6rem;}"
      ".copy-btn{border:none;border-radius:0.9rem;padding:0.85rem "
      "1.1rem;font-weight:700;font-size:0.95rem;"
      "cursor:pointer;background:#0f9d58;color:#fff;box-shadow:0 16px 28px "
      "rgba(15,157,88,0.28);transition:transform .2s,box-shadow .2s;}"
      ".copy-btn:hover{transform:translateY(-2px);box-shadow:0 18px 32px "
      "rgba(15,157,88,0.35);}"
      ".tip{margin-top:1.25rem;color:#3d527d;font-style:italic;}"
      ".device-meta{margin-top:2rem;font-size:0.9rem;color:#6a7796;}"
      "@media (max-width:640px){body{padding:1.5rem;} .top-card{padding:2rem;} "
      ".card{padding:1.75rem;} input{font-size:0.95rem;}}"
      "</style></head><body>"
      "<div class='container'>"
      "<section class='top-card'>"
      "<h1>Beeper Network Onboarding</h1>"
      "<p class='lead'>Securely connect your device to Wi-Fi and register it "
      "with the Beeper cloud relay. Please use a 2.4GHz network for best "
      "reliability.</p>"
      "<form method='POST'>"
      "<label>Wi-Fi SSID (2.4GHz)<input name='ssid' placeholder='Network name' "
      "value='" +
      ssidValue +
      "' required></label>"
      "<label>Wi-Fi Password<input name='pass' type='text' "
      "placeholder='Password' required></label>"
      "<label>Claim Code<input name='claim' placeholder='e.g. 4G7X9A' value='" +
      claimValue +
      "' required></label>"
      "<button class='submit-btn' type='submit'>Save & Reboot Device</button>"
      "</form>"
      "</section>"
      "<section class='section'>" +
      claimSection +
      "</section>"
      "<section class='card info-card'>"
      "<h2>Claim Lookup Portal</h2>"
      "<p>After the device rejoins Wi-Fi, open this link on any phone or "
      "computer to copy the webhook URL, poll secret, and curl command using "
      "your claim code.</p>"
      "<div class='info-block'>"
      "<div class='info-header'>Lookup URL</div>"
      "<div class='info-body'>"
      "<code id='lookup-url'>" +
      safeLookupDisplay +
      "</code>"
      "<button class='copy-btn' type='button' data-copy='" +
      safeLookupDisplay +
      "'>Copy Lookup URL</button>"
      "</div>"
      "</div>"
      "<p class='tip'>You can bookmark the link or share it with your "
      "automation team.</p>"
      "</section>"
      "<div class='device-meta'>Device ID: <strong>" +
      safeDeviceId +
      "</strong></div>"
      "</div>"
      "<script>"
      "(function(){"
      "function legacyCopy(text){"
      "var textarea=document.createElement('textarea');"
      "textarea.value=text;"
      "textarea.setAttribute('readonly','');"
      "textarea.style.position='absolute';"
      "textarea.style.left='-9999px';"
      "document.body.appendChild(textarea);"
      "var selected=document.getSelection();"
      "textarea.select();"
      "try{document.execCommand('copy');document.body.removeChild(textarea);if("
      "selected){selected.removeAllRanges();}"
      "return "
      "true;}catch(err){document.body.removeChild(textarea);if(selected){"
      "selected.removeAllRanges();}return false;}"
      "}"
      "function handleCopy(btn){"
      "var value=btn.getAttribute('data-copy');"
      "if(!value){return;}"
      "var original=btn.textContent;"
      "var "
      "onSuccess=function(){btn.textContent='Copied!';btn.disabled=true;"
      "setTimeout(function(){btn.textContent=original;btn.disabled=false;},"
      "1800);};"
      "var onFailure=function(){btn.textContent='Copy "
      "manually';setTimeout(function(){btn.textContent=original;},2000);};"
      "if(navigator.clipboard&&navigator.clipboard.writeText){"
      "navigator.clipboard.writeText(value).then(onSuccess).catch(function(){"
      "legacyCopy(value)?onSuccess():onFailure();});"
      "}else{legacyCopy(value)?onSuccess():onFailure();}"
      "}"
      "document.querySelectorAll('[data-copy]').forEach(function(btn){btn."
      "addEventListener('click',function(){handleCopy(btn);});});"
      "})();"
      "</script>"
      "</body></html>";
  configServer->send(200, "text/html", form);
}

void sendPortalRedirect() {
  configServer->sendHeader("Location", "http://192.168.4.1/", true);
  configServer->send(302, "text/plain", "");
}

void handleConfigSave() {
  String ssid = configServer->arg("ssid");
  String pass = configServer->arg("pass");
  String claim = configServer->arg("claim");

  if (ssid.isEmpty() || pass.isEmpty() || claim.isEmpty()) {
    configServer->send(
        400, "text/html",
        "<!DOCTYPE html><html><head><meta charset='utf-8'><meta "
        "name='viewport' content='width=device-width, initial-scale=1'>"
        "<title>Beeper Setup</title><style>body{font-family:'Segoe "
        "UI',Tahoma,sans-serif;background:#060f24;color:#fff;margin:0;"
        "display:flex;align-items:center;justify-content:center;height:100vh;} "
        ".panel{max-width:440px;width:90%;background:#16203d;"
        "border-radius:1.1rem;padding:2rem;box-shadow:0 22px 38px "
        "rgba(0,0,0,0.45);} h1{margin:0 0 1rem;font-size:1.55rem;}"
        "p{margin:0.5rem 0;color:#d6defa;} "
        ".link{display:inline-flex;margin-top:1.5rem;padding:0.75rem "
        "1.2rem;border-radius:0.8rem;"
        "background:#3d7dff;color:#fff;text-decoration:none;font-weight:600;"
        "box-shadow:0 18px 30px rgba(61,125,255,0.32);} </style></head>"
        "<body><div class='panel'><h1>Missing Details</h1><p>Please fill in "
        "the Wi-Fi SSID, password, and claim code to continue.</p>"
        "<a class='link' href='/'>Return to setup</a></div></body></html>");
    return;
  }

  saveWifiConfig(ssid, pass, claim);
  String lookupBase = String(backendBaseUrl) + "/link";
  String lookupUrl = lookupBase;
  if (!claim.isEmpty()) {
    lookupUrl += "?claim=" + claim;
  }
  String safeLookupUrl = lookupUrl;
  safeLookupUrl.replace("&", "&amp;");
  safeLookupUrl.replace("<", "&lt;");
  safeLookupUrl.replace(">", "&gt;");
  safeLookupUrl.replace("\"", "&quot;");
  safeLookupUrl.replace("'", "&#39;");
  String safeSsid = ssid;
  safeSsid.replace("&", "&amp;");
  safeSsid.replace("<", "&lt;");
  safeSsid.replace(">", "&gt;");
  safeSsid.replace("\"", "&quot;");
  safeSsid.replace("'", "&#39;");
  configServer->send(
      200, "text/html",
      "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' "
      "content='width=device-width, initial-scale=1'>"
      "<title>Configuration Saved</title>"
      "<style>"
      "*,*::before,*::after{box-sizing:border-box;}body{margin:0;font-family:'"
      "Segoe UI',Tahoma,sans-serif;"
      "background:linear-gradient(135deg,#060f24,#0b1f3f);color:#0b1320;min-"
      "height:100vh;display:flex;align-items:center;"
      "justify-content:center;padding:2.5rem;}h1,h2{margin:0;color:#0b1f3f;}p{"
      "color:#3a4661;line-height:1.5;}"
      "code{background:#f5f7fb;border-radius:0.5rem;padding:0.75rem "
      "1rem;display:block;word-break:break-all;"
      "font-size:0.95rem;color:#14213d;margin-bottom:0.75rem;}"
      ".container{max-width:760px;width:100%;display:grid;gap:1.75rem;}"
      ".top-card{background:#ffffff;border-radius:1.25rem;padding:2.5rem "
      "2.75rem;"
      "box-shadow:0 35px 50px rgba(8,18,46,0.35);border:1px solid "
      "rgba(255,255,255,0.35);}"
      ".lead{margin-top:0.75rem;margin-bottom:2rem;color:#4b5877;}"
      ".card{background:#ffffff;border-radius:1.25rem;padding:2rem "
      "2.5rem;box-shadow:0 30px 45px rgba(8,18,46,0.3);"
      "border:1px solid rgba(255,255,255,0.4);}"
      ".card.success{border:1px solid rgba(49,155,89,0.35);} "
      ".info-block{margin-top:1.5rem;}"
      ".info-header{font-weight:700;font-size:0.95rem;text-transform:uppercase;"
      "letter-spacing:0.08em;color:#3d527d;"
      "margin-bottom:0.75rem;}"
      ".info-body{display:flex;flex-direction:column;gap:0.6rem;}"
      ".copy-btn{border:none;border-radius:0.9rem;padding:0.85rem "
      "1.1rem;font-weight:700;font-size:0.95rem;"
      "cursor:pointer;background:#0f9d58;color:#fff;box-shadow:0 16px 28px "
      "rgba(15,157,88,0.28);transition:transform .2s,box-shadow .2s;}"
      ".copy-btn:hover{transform:translateY(-2px);box-shadow:0 18px 32px "
      "rgba(15,157,88,0.35);}"
      "@media (max-width:640px){body{padding:1.5rem;} .top-card{padding:2rem;} "
      ".card{padding:1.75rem;}}"
      "</style></head><body>"
      "<div class='container'>"
      "<section class='top-card'>"
      "<h1>Configuration Saved</h1>"
      "<p class='lead'>Device will restart and connect to <strong>" +
          safeSsid +
          "</strong>. Hotspot closes in <span id='countdown'>30</span> "
          "seconds.</p>"
          "</section>"
          "<section class='card'>"
          "<h2>Claim Lookup Portal</h2>"
          "<p>After the device rejoins Wi-Fi, open this link to retrieve "
          "webhook credentials.</p>"
          "<div class='info-block'>"
          "<div class='info-header'>Lookup URL</div>"
          "<div class='info-body'>"
          "<code id='lookup-url'>" +
          safeLookupUrl +
          "</code>"
          "<button class='copy-btn' type='button' data-copy='" +
          safeLookupUrl +
          "'>Copy Lookup URL</button>"
          "</div>"
          "</div>"
          "</section>"
          "</div>"
          "<script>"
          "(function(){"
          "function legacyCopy(text){"
          "var textarea=document.createElement('textarea');"
          "textarea.value=text;"
          "textarea.setAttribute('readonly','');"
          "textarea.style.position='absolute';"
          "textarea.style.left='-9999px';"
          "document.body.appendChild(textarea);"
          "var selected=document.getSelection();"
          "textarea.select();"
          "try{document.execCommand('copy');document.body.removeChild(textarea)"
          ";if("
          "selected){selected.removeAllRanges();}"
          "return "
          "true;}catch(err){document.body.removeChild(textarea);if(selected){"
          "selected.removeAllRanges();}return false;}"
          "}"
          "function handleCopy(btn){"
          "var value=btn.getAttribute('data-copy');"
          "if(!value){return;}"
          "var original=btn.textContent;"
          "var "
          "onSuccess=function(){btn.textContent='Copied!';btn.disabled=true;"
          "setTimeout(function(){btn.textContent=original;btn.disabled=false;},"
          "1800);};"
          "var onFailure=function(){btn.textContent='Copy "
          "manually';setTimeout(function(){btn.textContent=original;},2000);};"
          "if(navigator.clipboard&&navigator.clipboard.writeText){"
          "navigator.clipboard.writeText(value).then(onSuccess).catch(function("
          "){"
          "legacyCopy(value)?onSuccess():onFailure();});"
          "}else{legacyCopy(value)?onSuccess():onFailure();}"
          "}"
          "document.querySelectorAll('[data-copy]').forEach(function(btn){btn."
          "addEventListener('click',function(){handleCopy(btn);});});"
          "var countdownEl=document.getElementById('countdown');"
          "if(countdownEl){"
          "var seconds=30;"
          "function updateCountdown(){"
          "countdownEl.textContent=seconds;"
          "if(seconds>0){seconds--;setTimeout(updateCountdown,1000);}"
          "else{countdownEl.textContent='0';}"
          "}"
          "updateCountdown();"
          "}"
          "})();"
          "</script></body></html>");
  shouldRestart = true;
  restartRequestTime = millis();
}

void startConfigPortal() {
  // Initialize WebServer and DNSServer only when needed (lazy init for S3)
  if (configServer == nullptr) {
    configServer = new WebServer(80);
  }
  if (dnsServer == nullptr) {
    dnsServer = new DNSServer();
  }

  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIp, apIp, apNetmask);
  String apSsid = "Beeper-" + deviceId.substring(deviceId.length() - 4);
  WiFi.softAP(apSsid.c_str(), "");

  Serial.print("Config hotspot started: ");
  Serial.println(apSsid);
  Serial.println("Connect and browse to http://192.168.4.1");

  dnsServer->start(dnsPort, "*", apIp);

  configServer->on("/", HTTP_GET, sendConfigForm);
  configServer->on("/", HTTP_POST, handleConfigSave);
  configServer->on("/generate_204", HTTP_GET, sendPortalRedirect);
  configServer->on("/hotspot-detect.html", HTTP_GET, sendPortalRedirect);
  configServer->on("/fwlink", HTTP_GET, sendPortalRedirect);
  configServer->onNotFound(sendConfigForm);
  configServer->begin();

  configMode = true;
}

void armConfigReset() {
  if (configMode || resetTriggerArmed) {
    return;
  }

  Serial.println("Config reset button triggered. Clearing Wi-Fi credentials "
                 "and entering setup mode.");
  clearStoredConfig();
  WiFi.disconnect(true, true);
  startConfigPortal();
  resetTriggerArmed = true;
}

void checkResetButton() {
  int buttonState = digitalRead(resetButtonPin);

  if (buttonState == LOW) { // button pressed (assuming pull-up)
    if (resetPressStart == 0) {
      resetPressStart = millis();
    } else if (millis() - resetPressStart >= 3000) {
      armConfigReset();
    }
  } else {
    resetPressStart = 0;
    if (!configMode) {
      resetTriggerArmed = false;
    }
  }
}

bool claimDevice() {
  if (claimCode.isEmpty()) {
    Serial.println("No claim code stored; cannot claim yet.");
    return false;
  }

  HTTPClient http;
  String url = String(backendBaseUrl) + claimEndpointPath;
  String payload = "{\"device_id\":\"" + deviceId + "\",\"claim_code\":\"" +
                   claimCode + "\"}";

  Serial.println("Attempting device claim...");
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  int httpCode = http.POST(payload);

  if (httpCode == 200) {
    String response = http.getString();
    Serial.println("Claim response:");
    Serial.println(response);

    String extractedPollSecret = "";
    int startIdx = response.indexOf("\"poll_secret\":\"");
    if (startIdx >= 0) {
      startIdx += 15;
      int endIdx = response.indexOf("\"", startIdx);
      if (endIdx > startIdx) {
        extractedPollSecret = response.substring(startIdx, endIdx);
        extractedPollSecret.trim(); // Remove any whitespace
      }
    }

    String extractedWebhook = "";
    startIdx = response.indexOf("\"webhook_url\":\"");
    if (startIdx >= 0) {
      startIdx += 15;
      int endIdx = response.indexOf("\"", startIdx);
      if (endIdx > startIdx) {
        extractedWebhook = response.substring(startIdx, endIdx);
        extractedWebhook.replace("\\/", "/");
      }
    }

    if (!extractedPollSecret.isEmpty()) {
      Serial.print("Extracted poll_secret (first 8 chars): ");
      if (extractedPollSecret.length() >= 8) {
        Serial.println(extractedPollSecret.substring(0, 8));
      } else {
        Serial.println(extractedPollSecret);
      }
      Serial.print("Poll secret length: ");
      Serial.println(extractedPollSecret.length());
      saveClaimData(extractedPollSecret, extractedWebhook);
      http.end();
      Serial.println("Poll secret stored.");
      if (!extractedWebhook.isEmpty()) {
        Serial.print("Webhook URL: ");
        Serial.println(extractedWebhook);
      }
      return true;
    }

    Serial.println("Claim response missing poll_secret.");
  } else {
    Serial.print("Claim failed, HTTP code: ");
    Serial.println(httpCode);
    if (http.getSize() > 0) {
      Serial.println(http.getString());
    }
    if (httpCode == 401 || httpCode == 404) {
      Serial.println("Claim rejected. Clearing stored claim code and entering "
                     "setup mode.");
      prefs.remove("claim_code");
      claimCode = "";
      if (!configMode) {
        startConfigPortal();
      }
    }
  }

  http.end();
  return false;
}

void pollForTrigger() {
  if (pollSecret.isEmpty()) {
    return;
  }

  unsigned long now = millis();
  if (now - lastPoll < pollIntervalMs) {
    return;
  }
  lastPoll = now;

  HTTPClient http;
  String url =
      String(backendBaseUrl) + pollEndpointPath + "?device_id=" + deviceId;
  http.begin(url);
  http.addHeader("x-poll-secret", pollSecret.c_str());
  http.addHeader("x-device-id", deviceId.c_str());

  Serial.print("Polling with device_id: ");
  Serial.print(deviceId);
  Serial.print(", poll_secret (first 8 chars): ");
  if (pollSecret.length() >= 8) {
    Serial.println(pollSecret.substring(0, 8));
  } else {
    Serial.println(pollSecret);
  }

  int httpCode = http.GET();

  if (httpCode == 200) {
    String payload = http.getString();
    Serial.print("Status response: ");
    Serial.println(payload);
    if (payload.indexOf("\"trigger\":true") >= 0) {
      // Check for pattern_id in response
      int patternId = 0; // default to Classic Alert
      int patternIdIndex = payload.indexOf("\"pattern_id\":");
      if (patternIdIndex >= 0) {
        // Extract pattern_id value
        int valueStart = patternIdIndex + 13; // length of "\"pattern_id\":"
        int valueEnd = payload.indexOf(",", valueStart);
        if (valueEnd == -1) {
          valueEnd = payload.indexOf("}", valueStart);
        }
        if (valueEnd > valueStart) {
          String patternStr = payload.substring(valueStart, valueEnd);
          patternStr.trim();
          patternId = patternStr.toInt();
        }
      }
      saveSelectedPattern(patternId);
      Serial.println("Trigger detected. Playing audio...");

      // Build the audio URL from the backend base URL
      String audioUrl = String(backendBaseUrl) + "/audio/chalo";
      playAudioFile(audioUrl.c_str());
    }
    consecutivePollErrors = 0; // Reset error counter on success
  } else if (httpCode == 401) {
    consecutivePollErrors++;
    Serial.print("HTTP poll error: ");
    Serial.print(httpCode);
    Serial.print(" (consecutive errors: ");
    Serial.print(consecutivePollErrors);
    Serial.println(")");

    // If we get too many 401 errors, the device might not exist in DB
    // Clear poll secret to force re-claim
    if (consecutivePollErrors >= maxPollErrors) {
      Serial.println("Too many 401 errors. Device may not exist in database.");
      Serial.println("Clearing poll secret to force re-claim...");
      prefs.remove("poll_secret");
      prefs.remove("webhook_url");
      pollSecret = "";
      webhookUrl = "";
      // Reload claim code in case it was stored
      claimCode = prefs.getString("claim_code", "");
      consecutivePollErrors = 0; // Reset counter
      if (!claimCode.isEmpty()) {
        Serial.println("Poll secret cleared. Device will attempt to re-claim "
                       "on next loop.");
      } else {
        Serial.println("Poll secret cleared, but no claim code found. Device "
                       "needs to be reset to re-enter claim code.");
      }
    }
  } else {
    Serial.print("HTTP poll error: ");
    Serial.println(httpCode);
    consecutivePollErrors = 0; // Reset on non-401 errors
  }

  http.end();
}

void beepPattern() {
  // Validate selected pattern index
  int patternIdx = selectedPattern;
  if (patternIdx < 0 || patternIdx >= patternsCount) {
    patternIdx = 0;
  }

  const BeepPattern &bp = patterns[patternIdx];
  Serial.print("Playing pattern: ");
  Serial.println(bp.name);

  for (int cycle = 0; cycle < bp.cycles; cycle++) {
    for (int i = 0; i < bp.patternLength; i++) {
      digitalWrite(buzzerPin, HIGH);
      delay(bp.pattern[i][0]);
      digitalWrite(buzzerPin, LOW);
      delay(bp.pattern[i][1]);
    }
    if (cycle < bp.cycles - 1 && bp.cyclePause > 0) {
      delay(bp.cyclePause); // pause before repeating
    }
  }
}

void playAudioFile(const char *audioUrl) {
  Serial.print("[AUDIO] Playing audio from: ");
  Serial.println(audioUrl);

  // Connect to the audio URL and stream it through the MAX98357A amplifier
  audio.connecttohost(audioUrl);

  // Give it a moment to start
  delay(500);

  // Keep the audio object processing the stream
  // The audio.loop() function is called regularly in the main loop
  unsigned long timeout = millis() + 30000; // 30 second timeout

  while (millis() < timeout && audio.isRunning()) {
    audio.loop();
    delay(10);
  }

  Serial.println("[AUDIO] Playback finished");
}

void setup() {
  // Seed random number generator
  randomSeed(analogRead(0));

  // Wait longer for USB CDC on ESP32-S3
  delay(3000);

  Serial.begin(115200);

  // On ESP32-S3, Serial might not be detected as "ready" but will still work
  // Don't block - just wait a bit then start printing
  delay(1000);

  Serial.println("\n\n[BOOT] =========================================");
  Serial.println("[BOOT] ESP32-S3 Beeper starting...");
  Serial.print("[BOOT] Chip Model: ");
  Serial.println(ESP.getChipModel());
  Serial.print("[BOOT] Chip Revision: ");
  Serial.println(ESP.getChipRevision());
  Serial.print("[BOOT] CPU Frequency: ");
  Serial.print(ESP.getCpuFreqMHz());
  Serial.println(" MHz");
  Serial.println("[BOOT] Serial initialized successfully");
  Serial.flush();

  pinMode(buzzerPin, OUTPUT);
  digitalWrite(buzzerPin, LOW);
  Serial.println("[BOOT] Buzzer pin configured");
  Serial.flush();

  pinMode(resetButtonPin, INPUT_PULLUP);
  Serial.println("[BOOT] Reset button pin configured");
  Serial.flush();

  prefs.begin("beeper", false);
  Serial.println("[BOOT] Preferences initialized");

  // Initialize I2S audio for MAX98357A amplifier
  audio.setPinout(I2S_BCLK, I2S_LRC, I2S_DIN);
  audio.setVolume(21); // 0-21 volume range
  Serial.println("[BOOT] I2S audio configured (MAX98357A)");
  Serial.flush();

  // Initialize WiFi
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false); // We handle reconnection manually
  Serial.println("[BOOT] WiFi mode set to STA");
  Serial.flush();

  // Get device ID (MAC address)
  delay(100); // Small delay for WiFi to initialize
  deviceId = sanitizedMac();
  if (deviceId.isEmpty() || deviceId.length() != 12) {
    Serial.println("[BOOT] WARNING: Failed to get MAC address, using fallback");
    deviceId = "UNKNOWN" + String(random(1000, 9999));
  }
  Serial.print("[BOOT] Device ID: ");
  Serial.println(deviceId);
  Serial.flush();

  loadStoredConfig();

  if (!connectToWiFi()) {
    startConfigPortal();
    return;
  }

  if (pollSecret.isEmpty()) {
    if (!claimCode.isEmpty()) {
      claimDevice();
    } else {
      Serial.println("Device has Wi-Fi but no claim info; waiting for setup.");
    }
  }
}

void loop() {
  // Keep audio processing (non-blocking)
  audio.loop();

  checkResetButton();

  if (configMode) {
    if (dnsServer != nullptr) {
      dnsServer->processNextRequest();
    }
    if (configServer != nullptr) {
      configServer->handleClient();
    }

    if (shouldRestart && restartRequestTime > 0) {
      unsigned long elapsed = millis() - restartRequestTime;
      if (elapsed >= restartDelayMs) {
        Serial.println("Restart delay elapsed. Restarting device...");
        delay(1000);
        ESP.restart();
      }
    }
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi disconnected. Attempting reconnect...");
    if (!connectToWiFi()) {
      if (!configMode) {
        startConfigPortal();
      }
      return;
    }
  }

  if (pollSecret.isEmpty()) {
    if (claimDevice()) {
      Serial.println("Device claimed successfully.");
    } else {
      Serial.println("Claim pending. Will retry.");
      delay(3000);
    }
    return;
  }

  pollForTrigger();
}