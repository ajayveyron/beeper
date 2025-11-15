# Beeper - Remote Device Trigger System

A complete IoT solution for remotely triggering Beeper via webhooks. The system consists of ESP32-based hardware devices that connect to Wi-Fi and can be triggered through secure webhook endpoints, with a cloud relay server managing device provisioning, authentication, and trigger queuing.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Hardware Requirements](#hardware-requirements)
- [Software Requirements](#software-requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Getting Started](#getting-started)
- [Usage Guide](#usage-guide)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Security Considerations](#security-considerations)
- [Deployment](#deployment)

---

## Overview

Beeper is a remote device trigger system that enables you to:

- **Provision devices** with unique claim codes for secure pairing
- **Trigger devices remotely** via HTTP webhooks from any automation platform
- **Manage multiple devices** through a centralized cloud relay
- **Monitor device status** through polling mechanisms
- **Reset and reconfigure** devices easily through a built-in web portal

### Key Features

- 🔐 **Secure Authentication**: Webhook secrets and poll secrets for device security
- 📱 **Web-Based Setup**: User-friendly configuration portal on the device
- 🔄 **Auto-Reconnection**: Automatic Wi-Fi reconnection and device re-claiming
- 🎯 **Simple Integration**: RESTful API compatible with any webhook-capable service
- 🛠️ **Admin Tools**: Provision devices programmatically via admin endpoints
- 📊 **Database-Backed**: Persistent device storage using Supabase

---

## Architecture

The Beeper system consists of three main components:

```
┌─────────────────┐         ┌──────────────────┐         ┌──────────────┐
│   ESP32 Device  │◄───────►│  Cloud Relay     │◄───────►│  Supabase    │
│   (Hardware)    │  Poll   │  (Node.js/Express)│  Store  │  (Database)  │
└─────────────────┘         └──────────────────┘         └──────────────┘
                                      ▲
                                      │ Webhook
                                      │
                            ┌─────────┴─────────┐
                            │  Automation Apps  │
                            │  (Zapier, IFTTT,  │
                            │   Custom, etc.)   │
                            └───────────────────┘
```

### Component Details

1. **ESP32 Device** (`beeper.ino`)

   - Runs on ESP32 microcontroller
   - Creates Wi-Fi access point for initial setup
   - Connects to Wi-Fi and registers with cloud
   - Polls cloud server for trigger commands
   - Executes beep pattern when triggered

2. **Cloud Relay Server** (`server.js`)

   - Express.js REST API server
   - Handles device provisioning and claiming
   - Manages webhook triggers
   - Provides web UI for credential lookup
   - Authenticates requests via secrets

3. **Device Store** (`deviceStore.js`)
   - Supabase client wrapper
   - Manages device records in database
   - Handles CRUD operations for devices

---

## Hardware Requirements

### ESP32 Development Board

- **Model**: ESP32 (any variant with Wi-Fi)
- **GPIO Pins Used**:
  - GPIO 15: Buzzer output
  - GPIO 25: Reset button input (pulled up, connect to GND when pressed)

### Additional Components

- **Buzzer**: Active or passive buzzer (connected to GPIO 15 and GND)
- **Reset Button**: Momentary push button (connect between GPIO 25 and GND)
- **Power Supply**: USB power or external 5V supply

### Wiring Diagram

```
ESP32                    Components
─────────────────────────────────────
GPIO 15  ───────────────► Buzzer (+)
GND     ───────────────► Buzzer (-)
GPIO 25  ───────────────► Button (one side)
GND     ───────────────► Button (other side)
```

---

## Software Requirements

### For Device Development

- **Arduino IDE** (1.8.x or 2.x) or **PlatformIO**
- **ESP32 Board Support** for Arduino IDE
- **Required Libraries**:
  - `WiFi` (built-in)
  - `WebServer` (built-in)
  - `DNSServer` (built-in)
  - `HTTPClient` (built-in)
  - `Preferences` (built-in)

### For Server

- **Node.js** (v14 or higher)
- **npm** (v6 or higher)
- **Supabase Account** (for database)

---

## Installation

### 1. Clone the Repository

```bash
git clone <repository-url>
cd beeper
```

### 2. Install Server Dependencies

```bash
npm install
```

This will install:

- `express` - Web framework
- `body-parser` - Request body parsing
- `@supabase/supabase-js` - Supabase client

### 3. Set Up Supabase Database

1. Create a new Supabase project at [supabase.com](https://supabase.com)
2. Create a table named `devices` with the following schema:

```sql
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  claim_code TEXT NOT NULL,
  poll_secret TEXT,
  webhook_secret TEXT,
  trigger BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_devices_claim_code ON devices(claim_code);
```

3. Get your Supabase URL and Service Role Key from Project Settings → API

### 4. Configure Environment Variables

Create a `.env` file in the server root (or set environment variables):

```bash
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_DEVICES_TABLE=devices  # Optional, defaults to 'devices'

# Server Configuration
PORT=3000  # Optional, defaults to 3000
WEBHOOK_SECRET=your-admin-secret-here  # For admin endpoints
PUBLIC_BASE_URL=https://your-server-url.com  # Optional, for webhook URLs
```

**Important**: Never commit `.env` files to version control. Add `.env` to `.gitignore`.

### 5. Upload Firmware to ESP32

1. Open `beeper/beeper.ino` in Arduino IDE
2. Install ESP32 board support:
   - File → Preferences → Additional Board Manager URLs
   - Add: `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
   - Tools → Board → Boards Manager → Search "ESP32" → Install
3. Select your board:
   - Tools → Board → ESP32 Arduino → Your ESP32 model
4. Update the backend URL in `beeper.ino`:
   ```cpp
   const char *backendBaseUrl = "https://your-server-url.com";
   ```
5. Upload the sketch to your ESP32

---

## Configuration

### Device Configuration

The device can be configured in two ways:

#### Method 1: Web Portal (Recommended for First-Time Setup)

1. Power on the ESP32 device
2. Look for Wi-Fi network named `Beeper-XXXX` (last 4 chars of device ID)
3. Connect to this network (no password required)
4. Open browser and navigate to `http://192.168.4.1`
5. Enter:
   - **Wi-Fi SSID**: Your 2.4GHz network name
   - **Wi-Fi Password**: Your network password
   - **Claim Code**: Unique code (e.g., `4G7X9A`)
6. Click "Save & Reboot Device"
7. Device will restart and connect to your Wi-Fi

#### Method 2: Admin Provisioning (For Bulk Setup)

Use the admin API to pre-provision devices:

```bash
curl -X POST https://your-server.com/api/admin/provision \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: your-admin-secret" \
  -d '{
    "device_id": "AABBCCDDEEFF",
    "claim_code": "4G7X9A"
  }'
```

### Server Configuration

#### Environment Variables

| Variable                    | Required | Description                    | Default                     |
| --------------------------- | -------- | ------------------------------ | --------------------------- |
| `SUPABASE_URL`              | Yes      | Your Supabase project URL      | -                           |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Supabase service role key      | -                           |
| `SUPABASE_DEVICES_TABLE`    | No       | Database table name            | `devices`                   |
| `PORT`                      | No       | Server port                    | `3000`                      |
| `WEBHOOK_SECRET`            | No       | Admin endpoint secret          | `replace_with_admin_secret` |
| `PUBLIC_BASE_URL`           | No       | Public server URL for webhooks | Auto-detected               |

#### Backend URL in Firmware

Update `backendBaseUrl` in `beeper.ino` to match your server URL:

```cpp
const char *backendBaseUrl = "https://your-server-url.com";
```

---

## Getting Started

### Step 1: Start the Server

```bash
npm start
```

The server will start on port 3000 (or your configured port). You should see:

```
Server running on port 3000
```

### Step 2: Provision a Device

#### Option A: Via Web Portal

1. Power on ESP32
2. Connect to `Beeper-XXXX` Wi-Fi network
3. Go to `http://192.168.4.1`
4. Enter Wi-Fi credentials and claim code
5. Save and wait for device to reboot

#### Option B: Via Admin API

```bash
curl -X POST http://localhost:3000/api/admin/provision \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: your-admin-secret" \
  -d '{
    "device_id": "AABBCCDDEEFF",
    "claim_code": "4G7X9A"
  }'
```

### Step 3: Device Claims Itself

Once the device connects to Wi-Fi, it will automatically:

1. Send a claim request to the server
2. Receive `poll_secret` and `webhook_url`
3. Start polling for triggers

### Step 4: Retrieve Webhook Credentials

Visit the lookup portal:

```
https://your-server.com/link?claim=4G7X9A
```

You'll see:

- **Trigger URL**: Webhook endpoint for triggering the device
- **Webhook Secret**: Secret for authenticating webhook requests
- **Device Access Key**: Poll secret (for advanced use)
- **cURL Command**: Ready-to-use test command

### Step 5: Test the Device

Use the provided cURL command or make a POST request:

```bash
curl -X POST "https://your-server.com/api/device/webhook/AABBCCDDEEFF" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: your-webhook-secret" \
  -d '{"trigger":true}'
```

The device should beep within 3 seconds (poll interval).

---

## Usage Guide

### Triggering a Device

#### Using cURL

```bash
curl -X POST "https://your-server.com/api/device/webhook/DEVICE_ID" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: WEBHOOK_SECRET" \
  -d '{"trigger":true}'
```

#### Using JavaScript/Node.js

```javascript
const response = await fetch(
  "https://your-server.com/api/device/webhook/DEVICE_ID",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": "WEBHOOK_SECRET",
    },
    body: JSON.stringify({ trigger: true }),
  }
);

const result = await response.json();
console.log(result);
```

#### Using Python

```python
import requests

url = "https://your-server.com/api/device/webhook/DEVICE_ID"
headers = {
    "Content-Type": "application/json",
    "x-webhook-secret": "WEBHOOK_SECRET"
}
data = {"trigger": True}

response = requests.post(url, json=data, headers=headers)
print(response.json())
```

#### Integration with Automation Platforms

**Zapier**:

1. Create a new Zap
2. Choose trigger (e.g., "New Email")
3. Add action: "Webhooks by Zapier" → "POST"
4. Enter your webhook URL
5. Add header: `x-webhook-secret` = your secret
6. Body: `{"trigger":true}`

**IFTTT**:

1. Create new Applet
2. Choose trigger
3. Add action: "Webhooks" → "Make a web request"
4. URL: Your webhook URL
5. Method: POST
6. Headers: `x-webhook-secret: your-secret`
7. Body: `{"trigger":true}`

**Home Assistant**:

```yaml
automation:
  - alias: "Trigger Beeper"
    trigger:
      - platform: state
        entity_id: sensor.some_sensor
    action:
      - service: rest_command.beeper_trigger

rest_command:
  beeper_trigger:
    url: "https://your-server.com/api/device/webhook/DEVICE_ID"
    method: POST
    headers:
      x-webhook-secret: "WEBHOOK_SECRET"
    payload: '{"trigger":true}'
```

### Resetting a Device

To reset a device and return it to setup mode:

1. **Hardware Reset**: Hold the reset button for 3 seconds while device is powered
2. Device will clear stored credentials and start config portal
3. Connect to `Beeper-XXXX` network and reconfigure

### Finding Device Credentials

If you've lost your webhook credentials:

1. Visit: `https://your-server.com/link`
2. Enter your claim code
3. Optionally enter device ID (last 4 chars of MAC address)
4. Click "Fetch Credentials"
5. Copy the Trigger URL and Webhook Secret

### Managing Multiple Devices

Each device has a unique:

- **Device ID**: Based on MAC address (e.g., `AABBCCDDEEFF`)
- **Claim Code**: Assigned during provisioning
- **Webhook URL**: `https://your-server.com/api/device/webhook/{DEVICE_ID}`
- **Webhook Secret**: Unique per device

You can trigger different devices by using their respective webhook URLs and secrets.

---

## API Reference

### Public Endpoints

#### `GET /`

Health check endpoint.

**Response:**

```
relay ok
```

#### `GET /link`

Web interface for looking up device credentials.

**Query Parameters:**

- `claim` (optional): Claim code to look up
- `device` (optional): Device ID to narrow search

**Example:**

```
GET /link?claim=4G7X9A&device=AABBCCDDEEFF
```

#### `POST /api/device/claim`

Device claims itself with a claim code.

**Request Body:**

```json
{
  "device_id": "AABBCCDDEEFF",
  "claim_code": "4G7X9A"
}
```

**Response:**

```json
{
  "ok": true,
  "poll_secret": "abc123...",
  "webhook_url": "https://server.com/api/device/webhook/AABBCCDDEEFF",
  "webhook_secret": "xyz789..."
}
```

#### `POST /api/device/webhook/:deviceId`

Trigger a device via webhook.

**Headers:**

- `x-webhook-secret`: Webhook secret for authentication

**Request Body:**

```json
{
  "trigger": true
}
```

**Response:**

```json
{
  "ok": true
}
```

**Error Responses:**

- `401`: Missing or invalid webhook secret
- `404`: Device not found

#### `GET /api/device/status`

Device polls for trigger status.

**Query Parameters:**

- `device_id`: Device ID

**Headers:**

- `x-poll-secret`: Poll secret for authentication

**Response:**

```json
{
  "ok": true,
  "trigger": false
}
```

**Error Responses:**

- `400`: Missing device_id or x-poll-secret
- `401`: Invalid credentials
- `500`: Server error

### Admin Endpoints

#### `POST /api/admin/provision`

Provision a new device with a claim code.

**Headers:**

- `x-admin-secret`: Admin secret for authentication

**Request Body:**

```json
{
  "device_id": "AABBCCDDEEFF",
  "claim_code": "4G7X9A"
}
```

**Response:**

```json
{
  "ok": true
}
```

**Error Responses:**

- `400`: Missing device_id or claim_code
- `401`: Invalid admin secret
- `500`: Provisioning failed

---

## Troubleshooting

### Device Issues

#### Device Won't Connect to Wi-Fi

**Symptoms**: Device stays in config portal mode

**Solutions**:

1. Ensure you're using a **2.4GHz network** (ESP32 doesn't support 5GHz)
2. Check Wi-Fi password is correct
3. Verify network is within range
4. Try resetting device and re-entering credentials
5. Check Serial Monitor for connection errors

#### Device Not Beeping When Triggered

**Checklist**:

1. Verify device is connected to Wi-Fi (check Serial Monitor)
2. Confirm device has completed claiming (has `poll_secret`)
3. Check webhook URL and secret are correct
4. Verify server is running and accessible
5. Check device polling logs in Serial Monitor
6. Test buzzer hardware directly

#### Device Keeps Resetting

**Possible Causes**:

- Power supply insufficient (needs stable 5V)
- Wi-Fi connection unstable
- Server unreachable

**Solutions**:

1. Use a quality USB power supply (not computer USB)
2. Check Wi-Fi signal strength
3. Verify server URL in firmware is correct
4. Check Serial Monitor for error messages

#### Claim Code Not Working

**Symptoms**: Device shows "invalid claim code" or can't claim

**Solutions**:

1. Verify claim code matches what was provisioned
2. Check claim code is uppercase (auto-normalized)
3. Ensure device ID matches (if specified)
4. Check server logs for claim attempts
5. Re-provision device with admin API if needed

### Server Issues

#### Server Won't Start

**Check**:

1. Node.js version (needs v14+)
2. Environment variables are set correctly
3. Supabase credentials are valid
4. Port is not already in use
5. Dependencies installed (`npm install`)

#### Database Connection Errors

**Solutions**:

1. Verify `SUPABASE_URL` is correct
2. Check `SUPABASE_SERVICE_ROLE_KEY` is valid
3. Ensure table name matches (`devices` by default)
4. Verify table schema is correct
5. Check Supabase project is active

#### Webhook Returns 404

**Possible Causes**:

- Device not claimed yet
- Device ID mismatch
- Webhook secret incorrect

**Solutions**:

1. Check device has completed claiming
2. Verify device ID in URL matches actual device
3. Confirm webhook secret from lookup portal
4. Check server logs for authentication errors

### Network Issues

#### Device Can't Reach Server

**Symptoms**: Device shows connection errors in Serial Monitor

**Solutions**:

1. Verify `backendBaseUrl` in firmware is correct
2. Check server is publicly accessible (not localhost)
3. Test server URL in browser
4. Check firewall rules
5. Verify SSL certificate is valid (if using HTTPS)

#### Polling Timeout

**Symptoms**: Device stops responding to triggers

**Solutions**:

1. Check device is still connected to Wi-Fi
2. Verify server is running
3. Check network connectivity
4. Review Serial Monitor for polling errors
5. Reset device if needed

---

## Development

### Project Structure

```
beeper/
├── beeper/
│   └── beeper.ino          # ESP32 firmware
├── server.js               # Express server
├── deviceStore.js          # Supabase client wrapper
├── package.json            # Node.js dependencies
└── README.md              # This file
```

### Local Development

1. **Start Local Server**:

   ```bash
   npm start
   ```

2. **Update Firmware Backend URL**:

   ```cpp
   const char *backendBaseUrl = "http://localhost:3000";
   ```

   Or use a tunneling service like ngrok for device testing.

3. **Monitor Serial Output**:
   - Open Arduino IDE Serial Monitor
   - Set baud rate to 115200
   - Watch for connection and polling logs

### Testing

#### Test Device Claiming

```bash
# Provision device
curl -X POST http://localhost:3000/api/admin/provision \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: your-secret" \
  -d '{"device_id":"TEST123","claim_code":"TEST01"}'

# Claim device
curl -X POST http://localhost:3000/api/device/claim \
  -H "Content-Type: application/json" \
  -d '{"device_id":"TEST123","claim_code":"TEST01"}'
```

#### Test Webhook Trigger

```bash
# Get credentials from /link endpoint first, then:
curl -X POST http://localhost:3000/api/device/webhook/TEST123 \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: secret-from-claim-response" \
  -d '{"trigger":true}'
```

### Code Modifications

#### Changing Beep Pattern

Edit `beepPattern()` function in `beeper.ino`:

```cpp
void beepPattern() {
  const int pattern[][2] = {
    {120, 80},   // Beep duration, pause duration (ms)
    {120, 80},
    // Add more patterns...
  };
  // ... rest of function
}
```

#### Changing Poll Interval

Update `pollIntervalMs` in `beeper.ino`:

```cpp
const unsigned long pollIntervalMs = 5000; // 5 seconds
```

#### Adding Custom Endpoints

Add routes to `server.js`:

```javascript
app.post("/api/custom/endpoint", async (req, res) => {
  // Your logic here
  res.json({ ok: true });
});
```

---

## Security Considerations

### Secrets Management

- **Never commit secrets** to version control
- Use environment variables for all sensitive data
- Rotate secrets periodically
- Use strong, random secrets (32+ characters)

### Webhook Security

- **Always use HTTPS** in production
- Webhook secrets are required for all trigger requests
- Secrets are unique per device
- Store secrets securely in your automation platform

### Device Security

- Claim codes should be unique and hard to guess
- Poll secrets are device-specific and auto-generated
- Device IDs are based on MAC addresses (unique per device)
- Reset button allows physical access control

### Network Security

- Use WPA2/WPA3 for Wi-Fi networks
- Consider VPN for server access
- Implement rate limiting on webhook endpoints
- Monitor for suspicious activity

### Best Practices

1. **Change default admin secret** immediately
2. **Use HTTPS** for all production deployments
3. **Implement rate limiting** to prevent abuse
4. **Log all webhook triggers** for audit trails
5. **Regularly update dependencies** for security patches
6. **Use strong claim codes** (mix of letters and numbers, 6+ characters)

---

## Deployment

### Server Deployment

#### Option 1: Render.com (Recommended)

1. Create new Web Service on Render
2. Connect your GitHub repository
3. Set environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `WEBHOOK_SECRET`
   - `PUBLIC_BASE_URL` (your Render URL)
4. Deploy

#### Option 2: Heroku

1. Create Heroku app
2. Set config vars (same as above)
3. Deploy via Git or Heroku CLI

#### Option 3: VPS (DigitalOcean, AWS, etc.)

1. Set up Node.js on server
2. Clone repository
3. Install dependencies: `npm install --production`
4. Set up PM2 or systemd for process management
5. Configure reverse proxy (nginx) for HTTPS
6. Set environment variables
7. Start server

**PM2 Example**:

```bash
npm install -g pm2
pm2 start server.js --name beeper
pm2 save
pm2 startup
```

**Nginx Config**:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Firmware Deployment

1. Update `backendBaseUrl` in `beeper.ino` to production server URL
2. Compile and upload to ESP32 devices
3. Test each device after deployment
4. Keep firmware version documented

### Database Migration

If you need to migrate devices:

1. Export device data from old database
2. Import to new Supabase project
3. Update `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
4. Devices will automatically re-claim on next poll (claim codes preserved)

---

## License

[Specify your license here]

## Support

For issues, questions, or contributions:

- Open an issue on GitHub
- Check troubleshooting section
- Review Serial Monitor logs for device issues
- Check server logs for API issues

---

## Changelog

### Version 1.0.0

- Initial release
- Device provisioning and claiming
- Webhook-based triggering
- Web UI for credential lookup
- Supabase integration
- Auto-reconnection and error recovery

---

**Built with ❤️ for remote device automation**
