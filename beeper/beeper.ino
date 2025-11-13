#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <Preferences.h>

// ---------- Cloud configuration ----------
const char* backendBaseUrl = "https://beeper-ps1z.onrender.com";
const char* claimEndpointPath = "/api/device/claim";
const char* pollEndpointPath = "/api/device/status";

const unsigned long pollIntervalMs = 3000;
const unsigned long wifiConnectTimeoutMs = 20000;

// ---------- Hardware ----------
const int buzzerPin = 15; // GPIO15

// ---------- Globals ----------
Preferences prefs;
WebServer configServer(80);

String deviceId;
String wifiSsid;
String wifiPassword;
String claimCode;
String pollSecret;

bool configMode = false;
bool shouldRestart = false;
unsigned long lastPoll = 0;

// ---------- Helper ----------
String sanitizedMac() {
  String mac = WiFi.macAddress();
  mac.toUpperCase();
  mac.replace(":", "");
  return mac;
}

void loadStoredConfig() {
  wifiSsid = prefs.getString("wifi_ssid", "");
  wifiPassword = prefs.getString("wifi_pass", "");
  claimCode = prefs.getString("claim_code", "");
  pollSecret = prefs.getString("poll_secret", "");
}

void saveWifiConfig(const String& ssid, const String& pass, const String& claim) {
  prefs.putString("wifi_ssid", ssid);
  prefs.putString("wifi_pass", pass);
  prefs.putString("claim_code", claim);
  wifiSsid = ssid;
  wifiPassword = pass;
  claimCode = claim;
}

void savePollSecret(const String& secret) {
  pollSecret = secret;
  prefs.putString("poll_secret", secret);
  prefs.remove("claim_code"); // no longer needed after claim
  claimCode = "";
}

bool connectToWiFi() {
  if (wifiSsid.isEmpty()) {
    return false;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());

  Serial.print("Connecting to Wi-Fi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < wifiConnectTimeoutMs) {
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
  String form =
      "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Beeper Setup</title>"
      "<style>body{font-family:sans-serif;margin:2rem;}label{display:block;margin-top:1rem;}input{width:100%;padding:0.5rem;}"
      "button{margin-top:1.5rem;padding:0.6rem 1rem;font-size:1rem;}</style></head><body>"
      "<h1>Beeper Wi-Fi Setup</h1>"
      "<p>Enter your 2.4GHz home Wi-Fi details and the claim code printed on the device card.</p>"
      "<form method='POST'>"
      "<label>Wi-Fi SSID(2.4GHz)<input name='ssid' placeholder='Network name'/></label>"
      "<label>Wi-Fi Password<input name='pass' type='password' placeholder='Password'/></label>"
      "<label>Claim Code<input name='claim' placeholder='e.g. 4G7X9A'/></label>"
      "<button type='submit'>Save & Reboot</button>"
      "</form>"
      "</body></html>";
  configServer.send(200, "text/html", form);
}

void handleConfigSave() {
  String ssid = configServer.arg("ssid");
  String pass = configServer.arg("pass");
  String claim = configServer.arg("claim");

  if (ssid.isEmpty() || pass.isEmpty() || claim.isEmpty()) {
    configServer.send(400, "text/plain", "Missing SSID, password, or claim code.");
    return;
  }

  saveWifiConfig(ssid, pass, claim);
  configServer.send(200, "text/plain", "Saved! Device will reboot shortly.");
  shouldRestart = true;
}

void startConfigPortal() {
  WiFi.mode(WIFI_AP);
  String apSsid = "Beeper-" + deviceId.substring(deviceId.length() - 4);
  WiFi.softAP(apSsid.c_str(), "");

  Serial.print("Config hotspot started: ");
  Serial.println(apSsid);
  Serial.println("Connect and browse to http://192.168.4.1");

  configServer.on("/", HTTP_GET, sendConfigForm);
  configServer.on("/", HTTP_POST, handleConfigSave);
  configServer.begin();

  configMode = true;
}

bool claimDevice() {
  if (claimCode.isEmpty()) {
    Serial.println("No claim code stored; cannot claim yet.");
    return false;
  }

  HTTPClient http;
  String url = String(backendBaseUrl) + claimEndpointPath;
  String payload = "{\"device_id\":\"" + deviceId + "\",\"claim_code\":\"" + claimCode + "\"}";

  Serial.println("Attempting device claim...");
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  int httpCode = http.POST(payload);

  if (httpCode == 200) {
    String response = http.getString();
    Serial.println("Claim response:");
    Serial.println(response);

    int startIdx = response.indexOf("\"poll_secret\":\"");
    if (startIdx >= 0) {
      startIdx += 15;
      int endIdx = response.indexOf("\"", startIdx);
      if (endIdx > startIdx) {
        String secret = response.substring(startIdx, endIdx);
        savePollSecret(secret);
        http.end();
        Serial.println("Poll secret stored.");
        return true;
      }
    }

    Serial.println("Claim response missing poll_secret.");
  } else {
    Serial.print("Claim failed, HTTP code: ");
    Serial.println(httpCode);
    if (http.getSize() > 0) {
      Serial.println(http.getString());
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
  String url = String(backendBaseUrl) + pollEndpointPath + "?device_id=" + deviceId;

  http.begin(url);
  http.addHeader("x-poll-secret", pollSecret.c_str());
  http.addHeader("x-device-id", deviceId.c_str());
  int httpCode = http.GET();

  if (httpCode == 200) {
    String payload = http.getString();
    Serial.print("Status response: ");
    Serial.println(payload);
    if (payload.indexOf("\"trigger\":true") >= 0) {
      Serial.println("Trigger detected. Beeping...");
      digitalWrite(buzzerPin, HIGH);
      delay(50);
      digitalWrite(buzzerPin, LOW);
      delay(50);
      digitalWrite(buzzerPin, HIGH);
      delay(50);
      digitalWrite(buzzerPin, LOW);
      delay(50);
      digitalWrite(buzzerPin, HIGH);
      delay(500);
      digitalWrite(buzzerPin, LOW);
    }
  } else {
    Serial.print("HTTP poll error: ");
    Serial.println(httpCode);
  }

  http.end();
}

// happy rhythmic pattern – kept for future reuse
void beepPattern() {
  int pattern[][2] = {
    {100, 100}, {100, 50}, {100, 150},
    {200, 80}, {200, 80}, {300, 100},
    {100, 50}, {100, 50}, {400, 120},
    {600, 300}
  };

  int patternLength = sizeof(pattern) / sizeof(pattern[0]);
  unsigned long start = millis();

  while (millis() - start < 5000) {
    for (int i = 0; i < patternLength; i++) {
      digitalWrite(buzzerPin, HIGH);
      delay(pattern[i][0]);
      digitalWrite(buzzerPin, LOW);
      delay(pattern[i][1]);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(buzzerPin, OUTPUT);
  digitalWrite(buzzerPin, LOW);

  prefs.begin("beeper", false);

  WiFi.mode(WIFI_STA);
  deviceId = sanitizedMac();
  Serial.print("Device ID: ");
  Serial.println(deviceId);

  loadStoredConfig();

  if (!connectToWiFi()) {
    startConfigPortal();
  }
}

void loop() {
  if (configMode) {
    configServer.handleClient();

    if (shouldRestart) {
      delay(1000);
      ESP.restart();
    }
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi disconnected. Attempting reconnect...");
    if (!connectToWiFi()) {
      startConfigPortal();
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