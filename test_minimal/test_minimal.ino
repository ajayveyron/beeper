void setup() {
  delay(1000);
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n\n===== MINIMAL TEST =====");
  Serial.println("ESP32-S3 is working!");
  Serial.print("Chip Model: ");
  Serial.println(ESP.getChipModel());
  Serial.print("Flash Size: ");
  Serial.print(ESP.getFlashChipSize() / 1024 / 1024);
  Serial.println(" MB");
}

void loop() {
  delay(1000);
  Serial.println("Loop running...");
}
