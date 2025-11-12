// server.js
const express = require('express');
const bodyParser = require('body-parser');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || 'replace_with_a_strong_secret';

const app = express();
app.use(bodyParser.json());

// Simple in-memory trigger store
let trigger = false;

// Endpoint called by your LinkRunner webhook when form is submitted
// Expect header: x-webhook-secret: <SECRET>
app.post('/form', (req, res) => {
    trigger = true;
    res.sendStatus(200);
  });

// ESP32 polls this endpoint
// Expect header: x-poll-secret: <SECRET>
app.get('/status', (req, res) => {
  const secret = req.headers['x-poll-secret'] || '';
  if (secret !== SECRET) {
    return res.status(401).json({ ok: false, msg: 'unauthorized' });
  }
  // return trigger state and then reset it
  const t = trigger;
  trigger = false;
  return res.json({ trigger: t });
});

// health
app.get('/', (req, res) => res.send('relay ok'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});