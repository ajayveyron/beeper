// server.js
require('dotenv').config(); // loads .env into process.env

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const deviceStore = require('./deviceStore');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'Lacubra534';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

const app = express();
// Store raw body for signature verification (needed for Framer)
// This must come before bodyParser.json() to capture raw body
app.use('/api/device/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  // Store raw body for signature verification, then parse as JSON
  req.rawBody = req.body;
  try {
    req.body = JSON.parse(req.body.toString());
  } catch (e) {
    req.body = {};
  }
  next();
});
// Parse JSON for all other routes
app.use(bodyParser.json());

const generateSecret = () => crypto.randomBytes(16).toString('hex');

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const requireAdmin = (req, res, next) => {
  const header = req.headers['x-admin-secret'];
  if (!header || header !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, msg: 'admin unauthorized' });
  }
  return next();
};

app.get('/', (_req, res) => res.send('relay ok'));

// Local test audio endpoint for ESP32 (serves MP3 over plain HTTP)
app.get('/audio/kalimba', (_req, res) => {
  const filePath = path.join(__dirname, 'Kalimba.mp3');
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('Error sending kalimba audio file', err);
      if (!res.headersSent) {
        res.status(500).send('audio error');
      }
    }
  });
});

app.get('/audio/chalo', (_req, res) => {
  const filePath = path.join(__dirname, 'chalo.mp3');
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('Error sending chalo audio file', err);
      if (!res.headersSent) {
        res.status(500).send('audio error');
      }
    }
  });
});

const normalizeClaimCode = (value = '') => String(value).trim().toUpperCase();
const normalizeDeviceId = (value = '') => String(value).trim().toUpperCase();

const resolveBaseUrl = (req) => {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`.replace(/\/$/, '');
};

const findDeviceByClaimCode = async (claimCode, deviceId) => {
  const normalizedClaim = normalizeClaimCode(claimCode);
  const normalizedDevice = deviceId ? normalizeDeviceId(deviceId) : null;

  if (!normalizedClaim) {
    return null;
  }

  const record = await deviceStore.findByClaimCode(normalizedClaim, normalizedDevice || undefined);
  if (!record) {
    return null;
  }

  return { id: record.deviceId, record };
};

app.get('/link', async (req, res) => {
  const baseUrl = resolveBaseUrl(req);
  const { claim, device } = req.query || {};
  let match = null;
  let lookupError = null;

  if (claim) {
    try {
      match = await findDeviceByClaimCode(claim, device);
      // Auto-backfill URLs if device exists but URLs are missing
      if (match && match.record && (!match.record.webhookUrl || !match.record.claimLookupUrl)) {
        try {
          await deviceStore.updateUrls(match.id, baseUrl);
          // Re-fetch to get updated URLs
          match = await findDeviceByClaimCode(claim, device);
        } catch (backfillError) {
          console.warn('Failed to backfill URLs for device:', match.id, backfillError);
          // Continue anyway - URLs will be generated on the fly
        }
      }
    } catch (error) {
      console.error('claim lookup failed', error);
      lookupError = 'Unexpected error fetching device details. Please try again.';
    }
  }

  let bodyContent = `
    <section class="card hero">
      <h1>Beeper Device Setup</h1>
      <p class="lead">
        Enter your device claim code to get your trigger URL and access key.
        These details appear once your device has successfully connected to Wi-Fi and registered.
      </p>
      <form class="lookup-form" method="GET">
        <label>Claim Code
          <input name="claim" value="${escapeHtml(claim || '')}" placeholder="e.g. 4G7X9A" required />
        </label>
        <label class="optional">Device ID (optional)
          <input name="device" value="${escapeHtml(device || '')}" placeholder="MAC or printed device ID" />
        </label>
        <button type="submit">Fetch Credentials</button>
      </form>
    </section>
  `;

  if (claim) {
    if (lookupError) {
      bodyContent += `
        <section class="card status error">
          <h2>Lookup failed</h2>
          <p>${escapeHtml(lookupError)}</p>
        </section>
      `;
    } else if (!match) {
      bodyContent += `
        <section class="card status error">
          <h2>No device found</h2>
          <p>We couldn't locate a device for claim code <strong>${escapeHtml(claim)}</strong>${device ? ` with ID <strong>${escapeHtml(device)}</strong>` : ''}. Double-check the code printed on your card and try again.</p>
        </section>
      `;
    } else if (!match.record.pollSecret || !match.record.webhookSecret) {
      bodyContent += `
        <section class="card status pending">
          <h2>Device still pairing</h2>
          <p>Your device <strong>${escapeHtml(match.id)}</strong> has not completed its cloud claim yet.</p>
          <p>Keep the device powered and connected to Wi-Fi, then refresh this page in a few seconds.</p>
        </section>
      `;
    } else {
      const webhookUrl = `${baseUrl}/api/device/webhook/${match.id}`;
      const webhookSecret = match.record.webhookSecret;
      const pollSecret = match.record.pollSecret;
      const curlCommand = `curl -X POST "${webhookUrl}" -H 'Content-Type: application/json' -H 'x-webhook-secret: ${escapeHtml(webhookSecret)}' -d '{"trigger":true,"pattern_id":0}'`;

      // Pattern definitions matching beeper.ino
      const patterns = [
        { id: 0, name: 'Classic Alert', description: 'Original multi-beep pattern with pulses' },
        { id: 1, name: 'Short Ping', description: 'Quick triple ping' },
        { id: 2, name: 'Double Buzz', description: 'Two long buzzes' },
        { id: 3, name: 'Rising Alert', description: 'Progressively longer tones' },
        { id: 4, name: 'Morse SOS', description: 'SOS pattern (dot-dot-dot, dash-dash-dash, dot-dot-dot)' },
        { id: 5, name: 'Gentle Chime', description: 'Soft ascending chime' },
        { id: 6, name: 'Rapid Fire', description: 'Fast rapid-fire beeps' }
      ];

      let patternOptions = patterns.map(p => `<option value="${p.id}">${p.name} - ${p.description}</option>`).join('');

      bodyContent += `
        <section class="card success">
          <h2>Device Ready</h2>
          <p class="subtitle">Device <strong>${escapeHtml(match.id)}</strong> is connected and ready to use. Copy the values below into your automation or app.</p>
          <div class="info-block">
            <div class="info-header">BEEP PATTERN</div>
            <p class="info-description">Choose a beep pattern for this device. You can also specify the pattern when triggering via the webhook.</p>
            <div style="display: grid; gap: 1rem;">
              <select id="pattern-select" style="padding: 0.85rem 1rem; border-radius: 0.85rem; border: 1px solid rgba(102, 139, 255, 0.4); background: rgba(15, 22, 49, 0.92); color: #f4f7ff; font-size: 1rem;">
                ${patternOptions}
              </select>
              <button id="preview-button" style="padding: 0.85rem 1.2rem; border-radius: 0.85rem; border: none; background: #5c7cfa; color: white; font-weight: 600; cursor: pointer;">Play Preview</button>
            </div>
          </div>
          <div class="info-block">
            <div class="info-header">WEBHOOK URL</div>
            <p class="info-description">Use this URL to make your device beep. Keep this URL private. The secret must be provided in the x-webhook-secret header, not in the URL.</p>
            <code id="webhook-url">${escapeHtml(webhookUrl)}</code>
            <button class="copy" data-copy="${escapeHtml(webhookUrl)}">Copy Webhook URL</button>
          </div>
          <div class="info-block">
            <div class="info-header">WEBHOOK SECRET</div>
            <p class="info-description">Include this secret in the x-webhook-secret header when calling the webhook URL. Keep this secret private.</p>
            <code id="webhook-secret">${escapeHtml(webhookSecret)}</code>
            <button class="copy" data-copy="${escapeHtml(webhookSecret)}">Copy Webhook Secret</button>
          </div>
          <div class="info-block">
            <div class="info-header">POLL SECRET</div>
            <p class="info-description">Used by the device to check for triggers. You typically don't need this unless building custom integrations.</p>
            <code id="poll-secret">${escapeHtml(pollSecret)}</code>
            <button class="copy" data-copy="${escapeHtml(pollSecret)}">Copy Poll Secret</button>
          </div>
          <div class="info-block">
            <div class="info-header">CURL COMMAND</div>
            <p class="info-description">Run this command in your terminal to test the device. The webhook secret is included in the x-webhook-secret header for security.</p>
            <code id="curl-command">${escapeHtml(curlCommand)}</code>
            <button class="copy primary" data-copy="${escapeHtml(curlCommand)}">Copy curl Command</button>
          </div>
          <div class="info-block">
            <button class="test-webhook" data-webhook-url="${escapeHtml(webhookUrl)}" data-webhook-secret="${escapeHtml(webhookSecret)}">
              <span class="test-webhook-text">Test Webhook Trigger</span>
              <span class="test-webhook-spinner" style="display: none;">⏳</span>
            </button>
            <div class="test-webhook-feedback" style="display: none;"></div>
          </div>
        </section>
      `;
    }
  }

  const page = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Beeper Device Setup</title>
        <style>
          :root {
            color-scheme: light dark;
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            background: linear-gradient(135deg, #0d1226, #101c38);
            color: #e6ebff;
          }
          body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding: 3rem 1.5rem 4rem;
          }
          .container {
            width: 100%;
            max-width: 840px;
            display: grid;
            gap: 2rem;
          }
          .card {
            background: rgba(18, 26, 54, 0.9);
            border-radius: 1.25rem;
            padding: 2.5rem 3rem;
            box-shadow: 0 35px 60px rgba(8, 9, 23, 0.45);
            border: 1px solid rgba(255, 255, 255, 0.05);
          }
          h1, h2 {
            margin: 0 0 1rem;
            color: #f8fbff;
          }
          .lead {
            margin-bottom: 2rem;
            color: #b6c4ff;
            line-height: 1.6;
          }
          form {
            display: grid;
            gap: 1.5rem;
          }
          label {
            font-weight: 600;
            color: #dbe4ff;
            display: flex;
            flex-direction: column;
            gap: 0.6rem;
          }
          label.optional {
            font-weight: 500;
            color: rgba(219, 228, 255, 0.8);
          }
          input {
            background: rgba(15, 22, 49, 0.92);
            border: 1px solid rgba(102, 139, 255, 0.4);
            color: #f4f7ff;
            padding: 0.85rem 1rem;
            border-radius: 0.85rem;
            font-size: 1rem;
            transition: border-color 0.2s, box-shadow 0.2s;
          }
          input:focus {
            outline: none;
            border-color: #6f8dff;
            box-shadow: 0 0 0 4px rgba(111, 141, 255, 0.2);
          }
          button[type="submit"] {
            margin-top: 0.5rem;
            padding: 1rem 1.4rem;
            border-radius: 1rem;
            border: none;
            font-weight: 700;
            font-size: 1.05rem;
            background: linear-gradient(135deg, #5c7cfa, #4c6ef5);
            color: white;
            cursor: pointer;
            box-shadow: 0 22px 40px rgba(79, 109, 245, 0.35);
            transition: transform 0.2s, box-shadow 0.2s;
          }
          button[type="submit"]:hover {
            transform: translateY(-2px);
            box-shadow: 0 28px 46px rgba(79, 109, 245, 0.45);
          }
          .status {
            padding: 2.25rem 3rem;
          }
          .status h2 {
            margin-bottom: 0.75rem;
          }
          .status p {
            margin: 0.4rem 0;
            color: #d4ddff;
            line-height: 1.6;
          }
          .status.error {
            border: 1px solid rgba(255, 107, 129, 0.45);
            background: rgba(255, 82, 82, 0.12);
          }
          .status.pending {
            border: 1px solid rgba(255, 193, 7, 0.45);
            background: rgba(255, 214, 102, 0.12);
          }
          .success {
            border: 1px solid rgba(88, 204, 130, 0.4);
            background: rgba(46, 204, 113, 0.12);
          }
          .info-block {
            margin-top: 1.75rem;
            display: grid;
            gap: 0.75rem;
          }
          .info-header {
            text-transform: uppercase;
            letter-spacing: 0.08em;
            font-size: 0.85rem;
            color: rgba(255, 255, 255, 0.75);
            margin-bottom: 0.4rem;
          }
          .info-description {
            font-size: 0.85rem;
            color: rgba(255, 255, 255, 0.6);
            margin: 0 0 0.6rem 0;
            line-height: 1.4;
          }
          code {
            display: block;
            background: rgba(12, 19, 42, 0.95);
            border-radius: 0.85rem;
            padding: 0.95rem 1.1rem;
            font-family: 'SFMono-Regular', Menlo, ui-monospace, monospace;
            font-size: 0.95rem;
            color: #f8fbff;
            position: relative;
            word-break: break-all;
          }
          .copy {
            justify-self: start;
            padding: 0.7rem 1.1rem;
            border-radius: 0.8rem;
            background: rgba(255, 255, 255, 0.14);
            color: #fff;
            border: none;
            cursor: pointer;
            font-weight: 600;
            transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
          }
          .copy:hover {
            transform: translateY(-2px);
            box-shadow: 0 18px 30px rgba(0, 0, 0, 0.35);
          }
          .copy.primary {
            background: linear-gradient(135deg, #2ecc71, #27ae60);
            box-shadow: 0 22px 44px rgba(46, 204, 113, 0.4);
          }
          .copy.primary:hover {
            box-shadow: 0 26px 48px rgba(46, 204, 113, 0.5);
          }
          .test-webhook {
            justify-self: start;
            padding: 1rem 1.5rem;
            border-radius: 0.8rem;
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: #fff;
            border: none;
            cursor: pointer;
            font-weight: 600;
            font-size: 1rem;
            transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            box-shadow: 0 22px 44px rgba(102, 126, 234, 0.4);
          }
          .test-webhook:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 26px 48px rgba(102, 126, 234, 0.5);
          }
          .test-webhook:disabled {
            opacity: 0.7;
            cursor: not-allowed;
          }
          .test-webhook-spinner {
            display: inline-block;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          .test-webhook-feedback {
            margin-top: 0.75rem;
            padding: 0.75rem 1rem;
            border-radius: 0.6rem;
            font-size: 0.9rem;
            font-weight: 500;
          }
          .test-webhook-feedback.success {
            background: rgba(46, 204, 113, 0.2);
            border: 1px solid rgba(46, 204, 113, 0.4);
            color: #2ecc71;
          }
          .test-webhook-feedback.error {
            background: rgba(255, 107, 129, 0.2);
            border: 1px solid rgba(255, 107, 129, 0.4);
            color: #ff6b81;
          }
          .subtitle {
            color: rgba(255, 255, 255, 0.85);
            margin-bottom: 1.25rem;
            line-height: 1.5;
          }
          @media (max-width: 640px) {
            body {
              padding: 2rem 1rem 3rem;
            }
            .card {
              padding: 2rem 1.5rem;
            }
            .info-block {
              gap: 0.6rem;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          ${bodyContent}
        </div>
        <script>
          document.querySelectorAll('.copy').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var value = btn.getAttribute('data-copy');
              if (!value) { return; }
              navigator.clipboard.writeText(value).then(function() {
                var original = btn.textContent;
                btn.textContent = 'Copied!';
                btn.disabled = true;
                setTimeout(function() {
                  btn.textContent = original;
                  btn.disabled = false;
                }, 1600);
              }).catch(function() {
                btn.textContent = 'Copy failed';
                setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
              });
            });
          });

          // Pattern definitions for preview (matches beeper.ino)
          var patterns = [
            { name: 'Classic Alert', tones: [[120, 80], [120, 80], [120, 160], [40, 60], [40, 60], [40, 200], [300, 70], [300, 70], [600, 400]] },
            { name: 'Short Ping', tones: [[100, 100], [100, 100], [100, 300]] },
            { name: 'Double Buzz', tones: [[250, 100], [250, 300]] },
            { name: 'Rising Alert', tones: [[100, 50], [200, 50], [300, 50], [400, 200]] },
            { name: 'Morse SOS', tones: [[100, 50], [100, 50], [100, 150], [300, 50], [300, 50], [300, 150], [100, 50], [100, 50], [100, 300]] },
            { name: 'Gentle Chime', tones: [[50, 100], [75, 100], [100, 300]] },
            { name: 'Rapid Fire', tones: [[50, 50], [50, 50], [50, 50], [50, 50], [50, 50], [50, 300]] }
          ];

          // Preview button functionality
          var previewBtn = document.getElementById('preview-button');
          var patternSelect = document.getElementById('pattern-select');
          var audioContext = null;

          function initAudioContext() {
            if (!audioContext) {
              audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            return audioContext;
          }

          function playPreview() {
            var ctx = initAudioContext();
            var patternIdx = parseInt(patternSelect.value);
            var pattern = patterns[patternIdx];

            if (!pattern) { return; }

            var now = ctx.currentTime;
            var time = now;
            var frequency = 1000; // Hz for buzzer simulation

            // Create oscillator for audible tone (uses Web Audio API)
            pattern.tones.forEach(function(tone) {
              var onDuration = tone[0] / 1000; // Convert ms to seconds
              var offDuration = tone[1] / 1000;

              // Play tone if duration > 0
              if (onDuration > 0) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();

                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.frequency.value = frequency;
                gain.gain.setValueAtTime(0.1, time);
                gain.gain.setValueAtTime(0, time + onDuration);

                osc.start(time);
                osc.stop(time + onDuration);
              }

              time += onDuration + offDuration;
            });

            // Update button state
            if (previewBtn) {
              previewBtn.disabled = true;
              var original = previewBtn.textContent;
              previewBtn.textContent = 'Playing...';
              setTimeout(function() {
                previewBtn.textContent = original;
                previewBtn.disabled = false;
              }, (time - now) * 1000);
            }
          }

          if (previewBtn) {
            previewBtn.addEventListener('click', playPreview);
          }

          document.querySelectorAll('.test-webhook').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var webhookUrl = btn.getAttribute('data-webhook-url');
              var webhookSecret = btn.getAttribute('data-webhook-secret');
              var patternId = patternSelect ? parseInt(patternSelect.value) : 0;
              if (!webhookUrl || !webhookSecret) { return; }

              var textSpan = btn.querySelector('.test-webhook-text');
              var spinnerSpan = btn.querySelector('.test-webhook-spinner');
              var feedbackDiv = btn.parentElement.querySelector('.test-webhook-feedback');

              // Disable button and show spinner
              btn.disabled = true;
              textSpan.textContent = 'Testing...';
              spinnerSpan.style.display = 'inline-block';
              feedbackDiv.style.display = 'none';

              // Make the webhook request with secret in header for security
              fetch(webhookUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-webhook-secret': webhookSecret
                },
                body: JSON.stringify({ trigger: true, pattern_id: patternId })
              })
              .then(function(response) {
                return response.json().then(function(data) {
                  return { ok: response.ok, data: data };
                });
              })
              .then(function(result) {
                // Reset button
                btn.disabled = false;
                textSpan.textContent = 'Test Webhook Trigger';
                spinnerSpan.style.display = 'none';

                // Show feedback
                feedbackDiv.style.display = 'block';
                if (result.ok && result.data && result.data.ok) {
                  feedbackDiv.className = 'test-webhook-feedback success';
                  feedbackDiv.textContent = '✓ Webhook triggered successfully! Your device should beep shortly.';
                } else {
                  feedbackDiv.className = 'test-webhook-feedback error';
                  feedbackDiv.textContent = '✗ Failed to trigger webhook: ' + (result.data?.msg || 'Unknown error');
                }
              })
              .catch(function(error) {
                // Reset button
                btn.disabled = false;
                textSpan.textContent = 'Test Webhook Trigger';
                spinnerSpan.style.display = 'none';

                // Show error feedback
                feedbackDiv.style.display = 'block';
                feedbackDiv.className = 'test-webhook-feedback error';
                feedbackDiv.textContent = '✗ Network error: ' + (error.message || 'Failed to connect');
              });
            });
          });
        </script>
      </body>
    </html>
  `;

  res.type('html').send(page);
});

/**
 * Admin endpoint to provision a device with an initial claim code.
 * Body: { device_id, claim_code }
 */
app.post('/api/admin/provision', requireAdmin, async (req, res) => {
  const { device_id: deviceId, claim_code: claimCode } = req.body || {};
  if (!deviceId || !claimCode) {
    return res.status(400).json({ ok: false, msg: 'device_id and claim_code required' });
  }

  const normalizedDeviceId = normalizeDeviceId(deviceId);
  const normalizedClaimCode = normalizeClaimCode(claimCode);

  try {
    await deviceStore.provision(normalizedDeviceId, normalizedClaimCode);
    return res.json({ ok: true });
  } catch (error) {
    console.error('provision failed', error);
    return res.status(500).json({ ok: false, msg: 'failed to provision device' });
  }
});

/**
 * Device claims itself once the customer enters the claim code.
 * Body: { device_id, claim_code }
 * Returns: { poll_secret, webhook_url }
 */
app.post('/api/device/claim', async (req, res) => {
  const { device_id: deviceId, claim_code: claimCode } = req.body || {};
  if (!deviceId || !claimCode) {
    return res.status(400).json({ ok: false, msg: 'device_id and claim_code required' });
  }

  const normalizedDeviceId = normalizeDeviceId(deviceId);
  const normalizedClaimCode = normalizeClaimCode(claimCode);

  console.log(`[CLAIM] Attempting claim for device ${normalizedDeviceId} (original: ${deviceId}) with claim code ${normalizedClaimCode}`);

  try {
    let record = await deviceStore.getByDeviceId(normalizedDeviceId);
    
    // Auto-provision if device doesn't exist
    if (!record) {
      console.log(`[CLAIM] Device ${normalizedDeviceId} not found, auto-provisioning...`);
      await deviceStore.provision(normalizedDeviceId, normalizedClaimCode);
      record = await deviceStore.getByDeviceId(normalizedDeviceId);
      if (!record) {
        console.error(`[CLAIM] Failed to provision device ${normalizedDeviceId}`);
        return res.status(500).json({ ok: false, msg: 'failed to provision device' });
      }
    }

    if (record.claimCode !== normalizedClaimCode) {
      console.error(`[CLAIM] Claim code mismatch for device ${normalizedDeviceId}: expected ${record.claimCode}, got ${normalizedClaimCode}`);
      return res.status(401).json({ ok: false, msg: 'invalid claim code' });
    }

    const pollSecret = generateSecret();
    const webhookSecret = record.webhookSecret || generateSecret();
    
    const baseUrl = resolveBaseUrl(req);
    const webhookUrl = `${baseUrl}/api/device/webhook/${normalizedDeviceId}`;
    const claimLookupUrl = `${baseUrl}/link?claim=${normalizedClaimCode}`;
    
    await deviceStore.setSecrets(normalizedDeviceId, { 
      pollSecret, 
      webhookSecret, 
      webhookUrl, 
      claimLookupUrl 
    });

    console.log(`[CLAIM] Device ${normalizedDeviceId} claimed successfully. Poll secret: ${pollSecret.substring(0, 8)}...`);

    return res.json({
      ok: true,
      poll_secret: pollSecret,
      webhook_url: webhookUrl,
      webhook_secret: webhookSecret,
    });
  } catch (error) {
    console.error('device claim failed', error);
    return res.status(500).json({ ok: false, msg: 'failed to complete claim' });
  }
});

/**
 * Endpoint customers call (via their automation/webhook) to trigger the device.
 * Authentication is provided via multiple methods for compatibility:
 * 
 * For Framer and HMAC-based services:
 * - X-Webhook-Signature header: HMAC-SHA256 signature of the request body
 * 
 * For direct secret services:
 * 1. x-webhook-secret header (preferred - most secure, secret not in URL)
 * 2. Authorization: Bearer <secret> header
 * 3. Query parameter: ?secret=<secret> (less secure, secret visible in logs)
 * 4. Request body: { "secret": "<secret>" }
 * 
 * NOTE: The secret should NEVER be in the URL path for security reasons.
 * The URL format is: /api/device/webhook/:deviceId (deviceId only, no secret)
 */
app.post('/api/device/webhook/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  // Log incoming request for debugging (only log headers, not full body for security)
  console.log(`[WEBHOOK] Received webhook for device ${normalizedDeviceId}`);
  console.log(`[WEBHOOK] Headers:`, Object.keys(req.headers).reduce((acc, key) => {
    // Don't log sensitive headers in full
    if (key.toLowerCase().includes('secret') || key.toLowerCase().includes('authorization')) {
      acc[key] = req.headers[key] ? `${req.headers[key].substring(0, 8)}...` : undefined;
    } else if (key.toLowerCase().includes('signature')) {
      // Log signature header but truncate it (it's long)
      acc[key] = req.headers[key] ? `${req.headers[key].substring(0, 20)}...` : undefined;
    } else {
      acc[key] = req.headers[key];
    }
    return acc;
  }, {}));
  console.log(`[WEBHOOK] Query params:`, Object.keys(req.query));
  console.log(`[WEBHOOK] Body keys:`, req.body ? Object.keys(req.body) : 'none');

  try {
    const record = await deviceStore.getByDeviceId(normalizedDeviceId);
    if (!record) {
      console.log(`[WEBHOOK] Device ${normalizedDeviceId} not found`);
      return res.status(404).json({ ok: false, msg: 'device not found' });
    }

    if (!record.webhookSecret) {
      console.log(`[WEBHOOK] Device ${normalizedDeviceId} has no webhook secret configured`);
      return res.status(500).json({ ok: false, msg: 'webhook secret not configured for device' });
    }

    // Check for Framer-style HMAC signature verification
    // Framer uses 'framer-signature' header with format 'sha256=<hex>'
    // Also check for standard 'x-webhook-signature' for other services
    const framerSignatureHeader = req.headers['framer-signature'] || req.headers['Framer-Signature'];
    const standardSignatureHeader = req.headers['x-webhook-signature'] || req.headers['X-Webhook-Signature'];
    const signatureHeader = framerSignatureHeader || standardSignatureHeader;
    
    if (signatureHeader) {
      console.log(`[WEBHOOK] Detected signature authentication (${framerSignatureHeader ? 'Framer' : 'standard'})`);
      
      // Extract signature from header (Framer format: 'sha256=<hex>', standard: just hex)
      let receivedSig = signatureHeader;
      if (signatureHeader.startsWith('sha256=')) {
        receivedSig = signatureHeader.substring(7); // Remove 'sha256=' prefix
      }
      receivedSig = receivedSig.toLowerCase().trim();
      
      // Get raw body for signature verification
      const rawBody = req.rawBody ? req.rawBody.toString() : JSON.stringify(req.body);
      
      // Get submission ID (required for Framer signature verification)
      const submissionId = req.headers['framer-webhook-submission-id'] || req.headers['Framer-Webhook-Submission-Id'] || '';
      
      // According to Framer docs: HMAC-SHA256(payload + submissionId, secret)
      // The signature is computed as: hmac.update(payload).update(submissionId).digest('hex')
      // Reference: https://www.framer.com/help/articles/framer-form-webhook-setup/
      const hmac = crypto.createHmac('sha256', record.webhookSecret);
      hmac.update(rawBody);
      if (submissionId) {
        hmac.update(submissionId);
      }
      const expectedSignature = hmac.digest('hex').toLowerCase();
      
      const signatureMatches = receivedSig === expectedSignature;
      
      if (!signatureMatches) {
        console.log(`[WEBHOOK] Signature mismatch for device ${normalizedDeviceId}`);
        console.log(`[WEBHOOK] Received signature (first 16 chars): ${receivedSig.substring(0, 16)}...`);
        console.log(`[WEBHOOK] Expected signature (first 16 chars): ${expectedSignature.substring(0, 16)}...`);
        console.log(`[WEBHOOK] Raw body length: ${rawBody.length}`);
        console.log(`[WEBHOOK] Submission ID: ${submissionId || 'none'}`);
        console.log(`[WEBHOOK] Raw body preview: ${rawBody.substring(0, 100)}...`);
        return res.status(401).json({ ok: false, msg: 'invalid webhook signature' });
      }
      
      console.log(`[WEBHOOK] Signature authentication successful for device ${normalizedDeviceId}`);
    } else {
      // Fall back to direct secret comparison for other services
      let webhookSecret = 
        req.headers['x-webhook-secret'] || // Custom header (preferred)
        (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].split(' ')[1] : null) || // Bearer token (standard)
        req.query.secret || // Query parameter
        req.body?.secret || // Request body
        req.body?.webhook_secret; // Alternative body field name

      // Also check for Authorization header without Bearer prefix (some services send it directly)
      if (!webhookSecret && req.headers['authorization']) {
        const authHeader = req.headers['authorization'];
        if (!authHeader.startsWith('Bearer ')) {
          webhookSecret = authHeader;
        }
      }

      // Check for Basic Auth (username:password format)
      if (!webhookSecret && req.headers['authorization']?.startsWith('Basic ')) {
        try {
          const base64Credentials = req.headers['authorization'].split(' ')[1];
          const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
          const [username, password] = credentials.split(':');
          // Some services use username as device ID and password as secret, or vice versa
          webhookSecret = password || username;
        } catch (e) {
          // Ignore Basic Auth parsing errors
        }
      }

      if (!webhookSecret) {
        console.log(`[WEBHOOK] Authentication failed: No secret or signature found in any expected location`);
        return res.status(401).json({ ok: false, msg: 'webhook authentication required. Provide secret via x-webhook-secret header, X-Webhook-Signature header (for Framer), Authorization header, ?secret query param, or body.secret' });
      }

      if (record.webhookSecret !== webhookSecret) {
        console.log(`[WEBHOOK] Secret mismatch for device ${normalizedDeviceId}`);
        console.log(`[WEBHOOK] Received secret (first 8 chars): ${webhookSecret.substring(0, 8)}...`);
        console.log(`[WEBHOOK] Expected secret (first 8 chars): ${record.webhookSecret?.substring(0, 8)}...`);
        return res.status(401).json({ ok: false, msg: 'invalid webhook secret' });
      }

      console.log(`[WEBHOOK] Direct secret authentication successful for device ${normalizedDeviceId}`);
    }
    
    // Set the trigger flag for device polling
    // Also capture pattern_id from request body if provided
    const patternId = req.body?.pattern_id !== undefined ? parseInt(req.body.pattern_id) : 0;

    await deviceStore.setTrigger(normalizedDeviceId, true, patternId);
    // Create a trigger record in the triggers table for tracking
    await deviceStore.createTrigger(normalizedDeviceId, patternId);

    return res.json({ ok: true });
  } catch (error) {
    console.error('[WEBHOOK] webhook trigger failed', error);
    return res.status(500).json({ ok: false, msg: 'failed to queue trigger' });
  }
});

/**
 * Device polling endpoint.
 * Query: device_id
 * Headers: x-poll-secret
 */
app.get('/api/device/status', async (req, res) => {
  const deviceId = req.query.device_id;
  const pollSecret = req.headers['x-poll-secret'];

  if (!deviceId || !pollSecret) {
    return res.status(400).json({ ok: false, msg: 'device_id and x-poll-secret required' });
  }

  const normalizedDeviceId = normalizeDeviceId(deviceId);

  try {
    const record = await deviceStore.getByDeviceId(normalizedDeviceId);
    if (!record) {
      console.error(`[POLL] Device not found: ${normalizedDeviceId} (original: ${deviceId})`);
      return res.status(401).json({ ok: false, msg: 'unauthorized' });
    }
    
    console.log(`[POLL] Device ${normalizedDeviceId} found, checking poll secret...`);
    if (record.pollSecret !== pollSecret) {
      console.error(`[POLL] Secret mismatch for device ${normalizedDeviceId}:`, {
        received: pollSecret,
        expected: record.pollSecret,
        receivedLength: pollSecret?.length,
        expectedLength: record.pollSecret?.length,
      });
      return res.status(401).json({ ok: false, msg: 'unauthorized' });
    }

    const shouldTrigger = record.trigger;
    const patternId = record.pattern_id !== undefined ? record.pattern_id : 0;
    if (shouldTrigger) {
      await deviceStore.setTrigger(normalizedDeviceId, false);
    }

    const response = { ok: true, trigger: shouldTrigger };
    if (shouldTrigger) {
      response.pattern_id = patternId;
    }
    return res.json(response);
  } catch (error) {
    console.error('status poll failed', error);
    return res.status(500).json({ ok: false, msg: 'failed to fetch device status' });
  }
});

/**
 * Admin UI - Device Provisioning Interface
 */
app.get('/admin', async (req, res) => {
  const adminSecret = req.query.secret || req.headers['x-admin-secret'] || '';
  const isAuthenticated = adminSecret === ADMIN_SECRET;

  let devices = [];
  let provisionError = null;
  let provisionSuccess = null;

  if (isAuthenticated) {
    try {
      devices = await deviceStore.listAll(50);
    } catch (error) {
      console.error('Failed to list devices', error);
    }
  }

  const page = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Beeper Admin - Device Provisioning</title>
        <style>
          :root {
            color-scheme: light dark;
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            background: linear-gradient(135deg, #0d1226, #101c38);
            color: #e6ebff;
          }
          body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding: 3rem 1.5rem 4rem;
          }
          .container {
            width: 100%;
            max-width: 1000px;
            display: grid;
            gap: 2rem;
          }
          .card {
            background: rgba(18, 26, 54, 0.9);
            border-radius: 1.25rem;
            padding: 2.5rem 3rem;
            box-shadow: 0 35px 60px rgba(8, 9, 23, 0.45);
            border: 1px solid rgba(255, 255, 255, 0.05);
          }
          h1, h2 {
            margin: 0 0 1rem;
            color: #f8fbff;
          }
          .lead {
            margin-bottom: 2rem;
            color: #b6c4ff;
            line-height: 1.6;
          }
          form {
            display: grid;
            gap: 1.5rem;
          }
          label {
            font-weight: 600;
            color: #dbe4ff;
            display: flex;
            flex-direction: column;
            gap: 0.6rem;
          }
          input {
            background: rgba(15, 22, 49, 0.92);
            border: 1px solid rgba(102, 139, 255, 0.4);
            color: #f4f7ff;
            padding: 0.85rem 1rem;
            border-radius: 0.85rem;
            font-size: 1rem;
            transition: border-color 0.2s, box-shadow 0.2s;
          }
          input:focus {
            outline: none;
            border-color: #6f8dff;
            box-shadow: 0 0 0 4px rgba(111, 141, 255, 0.2);
          }
          button {
            padding: 1rem 1.4rem;
            border-radius: 1rem;
            border: none;
            font-weight: 700;
            font-size: 1.05rem;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
          }
          button[type="submit"] {
            background: linear-gradient(135deg, #5c7cfa, #4c6ef5);
            color: white;
            box-shadow: 0 22px 40px rgba(79, 109, 245, 0.35);
          }
          button[type="submit"]:hover {
            transform: translateY(-2px);
            box-shadow: 0 28px 46px rgba(79, 109, 245, 0.45);
          }
          .btn-secondary {
            background: rgba(255, 255, 255, 0.14);
            color: #fff;
          }
          .btn-secondary:hover {
            transform: translateY(-2px);
            box-shadow: 0 18px 30px rgba(0, 0, 0, 0.35);
          }
          .status {
            padding: 1.5rem 2rem;
            border-radius: 0.85rem;
            margin-bottom: 1.5rem;
          }
          .status.error {
            border: 1px solid rgba(255, 107, 129, 0.45);
            background: rgba(255, 82, 82, 0.12);
            color: #ff6b81;
          }
          .status.success {
            border: 1px solid rgba(88, 204, 130, 0.4);
            background: rgba(46, 204, 113, 0.12);
            color: #2ecc71;
          }
          .devices-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 1.5rem;
          }
          .devices-table th,
          .devices-table td {
            padding: 1rem;
            text-align: left;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          }
          .devices-table th {
            color: #b6c4ff;
            font-weight: 600;
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          .devices-table td {
            color: #e6ebff;
            font-size: 0.95rem;
          }
          .devices-table tr:hover {
            background: rgba(255, 255, 255, 0.03);
          }
          .badge {
            display: inline-block;
            padding: 0.3rem 0.7rem;
            border-radius: 0.5rem;
            font-size: 0.85rem;
            font-weight: 600;
          }
          .badge.claimed {
            background: rgba(46, 204, 113, 0.2);
            color: #2ecc71;
            border: 1px solid rgba(46, 204, 113, 0.4);
          }
          .badge.unclaimed {
            background: rgba(255, 193, 7, 0.2);
            color: #ffc107;
            border: 1px solid rgba(255, 193, 7, 0.4);
          }
          .generate-btn {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.2);
            padding: 0.5rem 1rem;
            border-radius: 0.6rem;
            font-size: 0.9rem;
            cursor: pointer;
            margin-left: 0.5rem;
          }
          .generate-btn:hover {
            background: rgba(255, 255, 255, 0.15);
          }
          code {
            font-family: 'SFMono-Regular', Menlo, ui-monospace, monospace;
            background: rgba(12, 19, 42, 0.95);
            padding: 0.2rem 0.5rem;
            border-radius: 0.4rem;
            font-size: 0.9rem;
          }
          @media (max-width: 640px) {
            body {
              padding: 2rem 1rem 3rem;
            }
            .card {
              padding: 2rem 1.5rem;
            }
            .devices-table {
              font-size: 0.85rem;
            }
            .devices-table th,
            .devices-table td {
              padding: 0.75rem 0.5rem;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <section class="card">
            <h1>Beeper Admin Portal</h1>
            <p class="lead">Provision and manage Beeper devices</p>
            
            ${!isAuthenticated ? `
              <form method="GET" action="/admin">
                <label>
                  Admin Secret
                  <input name="secret" type="password" placeholder="Enter admin secret" required />
                </label>
                <button type="submit">Authenticate</button>
              </form>
            ` : `
              <div style="margin-bottom: 2rem;">
                <a href="/admin" style="color: #b6c4ff; text-decoration: none;">← Back to login</a>
              </div>
              
              <h2>Provision New Device</h2>
              <form id="provision-form" method="POST" action="/api/admin/provision">
                <input type="hidden" name="admin_secret" value="${ADMIN_SECRET}" />
                <label>
                  Device ID
                  <input name="device_id" id="device_id" placeholder="e.g. AABBCCDDEEFF (MAC address)" required />
                  <small style="color: #8a9bb8; font-size: 0.85rem; margin-top: 0.3rem;">
                    Usually the device's MAC address in uppercase hex format
                  </small>
                </label>
                <label>
                  Claim Code
                  <div style="display: flex; gap: 0.5rem; align-items: flex-start;">
                    <input name="claim_code" id="claim_code" placeholder="e.g. 4G7X9A" required style="flex: 1;" />
                    <button type="button" class="generate-btn" onclick="generateClaimCode()">Generate</button>
                  </div>
                  <small style="color: #8a9bb8; font-size: 0.85rem; margin-top: 0.3rem;">
                    Human-readable code that users will enter during device setup
                  </small>
                </label>
                <button type="submit">Provision Device</button>
              </form>
              
              <div id="provision-feedback"></div>
              
              <h2 style="margin-top: 3rem;">Existing Devices (${devices.length})</h2>
              ${devices.length === 0 ? `
                <p style="color: #8a9bb8;">No devices provisioned yet.</p>
              ` : `
                <table class="devices-table">
                  <thead>
                    <tr>
                      <th>Device ID</th>
                      <th>Claim Code</th>
                      <th>Status</th>
                      <th>Webhook URL</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${devices.map(device => `
                      <tr>
                        <td><code>${escapeHtml(device.deviceId)}</code></td>
                        <td><code>${escapeHtml(device.claimCode)}</code></td>
                        <td>
                          <span class="badge ${device.pollSecret ? 'claimed' : 'unclaimed'}">
                            ${device.pollSecret ? 'Claimed' : 'Unclaimed'}
                          </span>
                        </td>
                        <td>
                          ${device.webhookSecret ? `
                            <a href="${resolveBaseUrl(req)}/link?claim=${escapeHtml(device.claimCode)}" 
                               style="color: #6f8dff; text-decoration: none; font-size: 0.9rem;">
                              View Credentials
                            </a>
                          ` : '<span style="color: #8a9bb8;">Not available</span>'}
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              `}
            `}
          </section>
        </div>
        <script>
          function generateClaimCode() {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let code = '';
            for (let i = 0; i < 6; i++) {
              code += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            document.getElementById('claim_code').value = code;
          }
          
          ${isAuthenticated ? `
          document.getElementById('provision-form').addEventListener('submit', async function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            const feedback = document.getElementById('provision-feedback');
            feedback.innerHTML = '<div class="status" style="margin-top: 1rem;">⏳ Provisioning...</div>';
            
            try {
              const response = await fetch('/api/admin/provision', {
                method: 'POST',
                headers: {
                  'x-admin-secret': formData.get('admin_secret'),
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  device_id: formData.get('device_id'),
                  claim_code: formData.get('claim_code')
                })
              });
              
              const result = await response.json();
              
              if (result.ok) {
                feedback.innerHTML = '<div class="status success">✓ Device provisioned successfully! Refresh to see it in the list.</div>';
                this.reset();
                setTimeout(() => location.reload(), 1500);
              } else {
                feedback.innerHTML = '<div class="status error">✗ ' + (result.msg || 'Provisioning failed') + '</div>';
              }
            } catch (error) {
              feedback.innerHTML = '<div class="status error">✗ Network error: ' + error.message + '</div>';
            }
          });
          ` : ''}
        </script>
      </body>
    </html>
  `;

  res.type('html').send(page);
});

/**
 * API endpoint to list all devices (for admin UI)
 */
app.get('/api/admin/devices', requireAdmin, async (req, res) => {
  try {
    const devices = await deviceStore.listAll(100);
    return res.json({ ok: true, devices });
  } catch (error) {
    console.error('Failed to list devices', error);
    return res.status(500).json({ ok: false, msg: 'failed to list devices' });
  }
});

/**
 * Admin endpoint to backfill webhook_url and claim_lookup_url for existing devices
 */
app.post('/api/admin/backfill-urls', requireAdmin, async (req, res) => {
  try {
    const baseUrl = resolveBaseUrl(req);
    const result = await deviceStore.backfillUrls(baseUrl);
    return res.json({ 
      ok: true, 
      updated: result.updated, 
      total: result.total,
      errors: result.errors 
    });
  } catch (error) {
    console.error('Backfill URLs failed', error);
    return res.status(500).json({ ok: false, msg: 'failed to backfill URLs' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});