#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <esp_wifi.h>

// ---------- Cloud configuration ----------
const char *backendBaseUrl = "https://beeper-ps1z.onrender.com";
const char *claimEndpointPath = "/api/device/claim";
const char *pollEndpointPath = "/api/device/status";

const unsigned long pollIntervalMs = 3000;
const unsigned long wifiConnectTimeoutMs = 20000;

// ---------- Hardware ----------
const int buzzerPin = 15;      // GPIO15
const int resetButtonPin = 25; // GPIO0; connect to GND when pressed

// ---------- Globals ----------
Preferences prefs;
WebServer configServer(80);
DNSServer dnsServer;

const byte dnsPort = 53;
IPAddress apIp(192, 168, 4, 1);
IPAddress apNetmask(255, 255, 255, 0);

String deviceId;
String wifiSsid;
String wifiPassword;
String claimCode;
String pollSecret;
String webhookUrl;

bool configMode = false;
bool shouldRestart = false;
unsigned long restartRequestTime = 0;
unsigned long lastPoll = 0;
unsigned long resetPressStart = 0;
bool resetTriggerArmed = false;
const unsigned long restartDelayMs = 30000; // 30 seconds delay before restart

// ---------- Helper ----------
String sanitizedMac() {
  uint8_t mac[6] = {0};
  esp_wifi_get_mac(WIFI_IF_STA, mac);

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
  prefs.remove("claim_code"); // no longer needed after claim
  claimCode = "";
}

void clearStoredConfig() {
  prefs.remove("wifi_ssid");
  prefs.remove("wifi_pass");
  prefs.remove("poll_secret");
  prefs.remove("claim_code");
  prefs.remove("webhook_url");

  wifiSsid = "";
  wifiPassword = "";
  pollSecret = "";
  claimCode = "";
  webhookUrl = "";
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
      claimValue.toUpperCase() +
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
  configServer.send(200, "text/html", form);
}

void sendPortalRedirect() {
  configServer.sendHeader("Location", "http://192.168.4.1/", true);
  configServer.send(302, "text/plain", "");
}

void handleConfigSave() {
  String ssid = configServer.arg("ssid");
  String pass = configServer.arg("pass");
  String claim = configServer.arg("claim");

  if (ssid.isEmpty() || pass.isEmpty() || claim.isEmpty()) {
    configServer.send(
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
  configServer.send(
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
          "</strong>. Hotspot closes in ~30 seconds.</p>"
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
          "})();"
          "</script></body></html>");
  shouldRestart = true;
  restartRequestTime = millis();
}

void startConfigPortal() {
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(apIp, apIp, apNetmask);
  String apSsid = "Beeper-" + deviceId.substring(deviceId.length() - 4);
  WiFi.softAP(apSsid.c_str(), "");

  Serial.print("Config hotspot started: ");
  Serial.println(apSsid);
  Serial.println("Connect and browse to http://192.168.4.1");

  dnsServer.start(dnsPort, "*", apIp);

  configServer.on("/", HTTP_GET, sendConfigForm);
  configServer.on("/", HTTP_POST, handleConfigSave);
  configServer.on("/generate_204", HTTP_GET, sendPortalRedirect);
  configServer.on("/hotspot-detect.html", HTTP_GET, sendPortalRedirect);
  configServer.on("/fwlink", HTTP_GET, sendPortalRedirect);
  configServer.onNotFound(sendConfigForm);
  configServer.begin();

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
      Serial.println("Trigger detected. Beeping...");
      beepPattern();
    }
  } else {
    Serial.print("HTTP poll error: ");
    Serial.println(httpCode);
  }

  http.end();
}

void beepPattern() {
  const int pattern[][2] = {
      {120, 80}, {120, 80}, {120, 160}, // opening triple beep
      {40, 60},  {40, 60},  {40, 200},  // quick chirps
      {300, 70}, {300, 70},             // two strong pulses
      {600, 400}                        // lingering finish
  };

  const int patternLength = sizeof(pattern) / sizeof(pattern[0]);

  for (int cycle = 0; cycle < 3; cycle++) {
    for (int i = 0; i < patternLength; i++) {
      digitalWrite(buzzerPin, HIGH);
      delay(pattern[i][0]);
      digitalWrite(buzzerPin, LOW);
      delay(pattern[i][1]);
    }
    if (cycle < 2) {
      delay(300); // short pause before repeating
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(buzzerPin, OUTPUT);
  digitalWrite(buzzerPin, LOW);
  pinMode(resetButtonPin, INPUT_PULLUP);

  prefs.begin("beeper", false);

  WiFi.mode(WIFI_STA);
  deviceId = sanitizedMac();
  Serial.print("Device ID: ");
  Serial.println(deviceId);

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
  checkResetButton();

  if (configMode) {
    dnsServer.processNextRequest();
    configServer.handleClient();

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