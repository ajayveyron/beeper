// server.js
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.WEBHOOK_SECRET || 'replace_with_admin_secret';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const app = express();
app.use(bodyParser.json());

/**
 * In-memory device store
 * Structure:
 * {
 *   claimCode: string,
 *   pollSecret: string | null,
 *   webhookSecret: string | null,
 *   trigger: boolean
 * }
 */
const devices = new Map();

const generateSecret = () => crypto.randomBytes(16).toString('hex');

const requireAdmin = (req, res, next) => {
  const header = req.headers['x-admin-secret'];
  if (!header || header !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, msg: 'admin unauthorized' });
  }
  return next();
};

app.get('/', (_req, res) => res.send('relay ok'));

/**
 * Admin endpoint to provision a device with an initial claim code.
 * Body: { device_id, claim_code }
 */
app.post('/api/admin/provision', requireAdmin, (req, res) => {
  const { device_id: deviceId, claim_code: claimCode } = req.body || {};
  if (!deviceId || !claimCode) {
    return res.status(400).json({ ok: false, msg: 'device_id and claim_code required' });
  }

  devices.set(deviceId, {
    claimCode,
    pollSecret: null,
    webhookSecret: null,
    trigger: false,
  });

  return res.json({ ok: true });
});

/**
 * Device claims itself once the customer enters the claim code.
 * Body: { device_id, claim_code }
 * Returns: { poll_secret, webhook_url }
 */
app.post('/api/device/claim', (req, res) => {
  const { device_id: deviceId, claim_code: claimCode } = req.body || {};
  if (!deviceId || !claimCode) {
    return res.status(400).json({ ok: false, msg: 'device_id and claim_code required' });
  }

  const record = devices.get(deviceId);
  if (!record) {
    return res.status(404).json({ ok: false, msg: 'device not provisioned' });
  }

  if (record.claimCode !== claimCode) {
    return res.status(401).json({ ok: false, msg: 'invalid claim code' });
  }

  record.pollSecret = generateSecret();
  record.webhookSecret = record.webhookSecret || generateSecret();
  record.trigger = false;

  const webhookUrl = `${PUBLIC_BASE_URL}/api/device/webhook/${deviceId}/${record.webhookSecret}`;

  return res.json({
    ok: true,
    poll_secret: record.pollSecret,
    webhook_url: webhookUrl,
  });
});

/**
 * Endpoint customers call (via their automation/webhook) to trigger the device.
 */
app.post('/api/device/webhook/:deviceId/:webhookSecret', (req, res) => {
  const { deviceId, webhookSecret } = req.params;
  const record = devices.get(deviceId);

  if (!record || record.webhookSecret !== webhookSecret) {
    return res.status(404).json({ ok: false, msg: 'unknown webhook' });
  }

  record.trigger = true;
  return res.json({ ok: true });
});

/**
 * Device polling endpoint.
 * Query: device_id
 * Headers: x-poll-secret
 */
app.get('/api/device/status', (req, res) => {
  const deviceId = req.query.device_id;
  const pollSecret = req.headers['x-poll-secret'];

  if (!deviceId || !pollSecret) {
    return res.status(400).json({ ok: false, msg: 'device_id and x-poll-secret required' });
  }

  const record = devices.get(deviceId);
  if (!record || record.pollSecret !== pollSecret) {
    return res.status(401).json({ ok: false, msg: 'unauthorized' });
  }

  const shouldTrigger = record.trigger;
  record.trigger = false;

  return res.json({ ok: true, trigger: shouldTrigger });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});