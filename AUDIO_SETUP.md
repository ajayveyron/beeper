# Beeper Audio Setup Guide

## Hardware Configuration

Your Beeper device now supports full MP3 audio playback through a MAX98357A amplifier connected to your ESP32-S3.

### Wiring (GPIO pins):
- **GPIO 15**: BCLK (Bit Clock)
- **GPIO 16**: LRCK (Left/Right Clock / Word Select)
- **GPIO 17**: DIN (Data In)
- **MAX98357A**: Connect GND and VCC for power

## Installation

### Using PlatformIO (Recommended)

1. Install PlatformIO IDE or CLI
2. The project already has `platformio.ini` configured with the necessary library
3. Build and upload:
   ```bash
   cd /Users/ajaypawriya/Desktop/beeper/beeper
   platformio run -t upload
   ```

### Using Arduino IDE

1. Open Arduino IDE
2. Go to **Sketch → Include Library → Manage Libraries**
3. Search for and install: **ESP32-audioI2S** by schreibfaul1 (version 2.7.0 or later)
4. Select board: **ESP32-S3-DevKitC-1**
5. Upload the sketch

## How It Works

### Audio Playback Flow

When a webhook trigger is received:

1. **Device polls** the server every 3 seconds
2. **Server returns** `{"trigger": true}`
3. **Device calls** `playAudioFile()` with the audio URL
4. **Audio library**:
   - Downloads the MP3 stream from `https://your-server/audio/chalo`
   - Decodes MP3 on-the-fly
   - Streams decoded audio to MAX98357A via I2S
   - Amplifier plays audio through speaker

### Test Trigger

To test the audio playback:

```bash
curl -X POST "http://your-server/api/device/webhook/DEVICE_ID" \
  -H 'Content-Type: application/json' \
  -H 'x-webhook-secret: YOUR_SECRET' \
  -d '{"trigger":true}'
```

The device will:
1. Detect the trigger
2. Download chalo.mp3 from the server
3. Play it through the speaker (30 second timeout)

## Audio Files Available

- `/audio/chalo` - Chalo sound effect
- `/audio/kalimba` - Kalimba test audio

## Adjusting Volume

Change the volume in `setup()`:
```cpp
audio.setVolume(21); // Range: 0-21 (21 is max)
```

## Troubleshooting

### No sound output
- Check I2S pin connections (GPIO 15, 16, 17)
- Verify MAX98357A power supply
- Check speaker connections to amplifier
- Monitor serial output for audio initialization messages

### Playback stops early
- Increase the timeout in `playAudioFile()` function
- Check WiFi signal strength
- Verify server is serving audio files correctly

### Library compilation errors
- Ensure ESP32-audioI2S is installed
- Check that your board selection is ESP32-S3-DevKitC-1 or compatible
- Try updating to latest library version

## Serial Debug Output

Monitor at 115200 baud to see audio playback logs:
```
[AUDIO] Playing audio from: https://your-server/audio/chalo
[AUDIO] Playback finished
```
