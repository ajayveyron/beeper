// server.js
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const deviceStore = require('./deviceStore');

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.WEBHOOK_SECRET || 'replace_with_admin_secret';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

const app = express();
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
    } catch (error) {
      console.error('claim lookup failed', error);
      lookupError = 'Unexpected error fetching device details. Please try again.';
    }
  }

  let bodyContent = `
    <section class="card hero">
      <h1>Beeper Claim Lookup</h1>
      <p class="lead">
        Enter your device claim code to fetch the webhook URL, poll secret, and a ready-to-use curl command.
        These details appear once your device has successfully joined Wi-Fi and registered with the cloud.
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
      const webhookUrl = `${baseUrl}/api/device/webhook/${match.id}/${match.record.webhookSecret}`;
      const pollSecret = match.record.pollSecret;
      const curlCommand = `curl -X POST "${webhookUrl}" -H 'Content-Type: application/json' -d '{"trigger":true}'`;

      bodyContent += `
        <section class="card success">
          <h2>Integration Ready</h2>
          <p class="subtitle">Device <strong>${escapeHtml(match.id)}</strong> is paired. Copy the values below into your automation workflow.</p>
          <div class="info-block">
            <div class="info-header">Webhook URL</div>
            <code id="webhook-url">${escapeHtml(webhookUrl)}</code>
            <button class="copy" data-copy="${escapeHtml(webhookUrl)}">Copy Webhook URL</button>
          </div>
          <div class="info-block">
            <div class="info-header">Poll Secret</div>
            <code id="poll-secret">${escapeHtml(pollSecret)}</code>
            <button class="copy" data-copy="${escapeHtml(pollSecret)}">Copy Poll Secret</button>
          </div>
          <div class="info-block">
            <div class="info-header">curl Command</div>
            <code id="curl-command">${escapeHtml(curlCommand)}</code>
            <button class="copy primary" data-copy="${escapeHtml(curlCommand)}">Copy curl Command</button>
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
        <title>Beeper Link Portal</title>
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
    await deviceStore.setSecrets(normalizedDeviceId, { pollSecret, webhookSecret });

    console.log(`[CLAIM] Device ${normalizedDeviceId} claimed successfully. Poll secret: ${pollSecret.substring(0, 8)}...`);

    const baseUrl = resolveBaseUrl(req);
    const webhookUrl = `${baseUrl}/api/device/webhook/${normalizedDeviceId}/${webhookSecret}`;

    return res.json({
      ok: true,
      poll_secret: pollSecret,
      webhook_url: webhookUrl,
    });
  } catch (error) {
    console.error('device claim failed', error);
    return res.status(500).json({ ok: false, msg: 'failed to complete claim' });
  }
});

/**
 * Endpoint customers call (via their automation/webhook) to trigger the device.
 */
app.post('/api/device/webhook/:deviceId/:webhookSecret', requireAdmin, async (req, res) => {
  const { deviceId, webhookSecret } = req.params;
  const normalizedDeviceId = normalizeDeviceId(deviceId);

  try {
    const record = await deviceStore.getByDeviceId(normalizedDeviceId);
    if (!record || record.webhookSecret !== webhookSecret) {
      return res.status(404).json({ ok: false, msg: 'unknown webhook' });
    }

    await deviceStore.setTrigger(normalizedDeviceId, true);
    return res.json({ ok: true });
  } catch (error) {
    console.error('webhook trigger failed', error);
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
    if (shouldTrigger) {
      await deviceStore.setTrigger(normalizedDeviceId, false);
    }

    return res.json({ ok: true, trigger: shouldTrigger });
  } catch (error) {
    console.error('status poll failed', error);
    return res.status(500).json({ ok: false, msg: 'failed to fetch device status' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});