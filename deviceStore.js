const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE_NAME = process.env.SUPABASE_DEVICES_TABLE || 'devices';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before starting the server.'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const toCamelCaseRecord = (row) => {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    claimCode: row.claim_code,
    pollSecret: row.poll_secret,
    webhookSecret: row.webhook_secret,
    trigger: row.trigger,
  };
};

const handleError = (context, error) => {
  const message = error?.message || error?.toString() || 'unknown error';
  throw new Error(`${context}: ${message}`);
};

const deviceStore = {
  async provision(deviceId, claimCode) {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .upsert(
        {
          device_id: deviceId,
          claim_code: claimCode,
          poll_secret: null,
          webhook_secret: null,
          trigger: false,
        },
        { onConflict: 'device_id' }
      )
      .select()
      .maybeSingle();

    if (error) handleError('provision failed', error);
    return toCamelCaseRecord(data);
  },

  async getByDeviceId(deviceId) {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select('*')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (error) handleError('getByDeviceId failed', error);
    return toCamelCaseRecord(data);
  },

  async findByClaimCode(claimCode, deviceId) {
    let query = supabase.from(TABLE_NAME).select('*').eq('claim_code', claimCode).limit(1);

    if (deviceId) {
      query = query.eq('device_id', deviceId);
    }

    const { data, error } = await query.maybeSingle();

    if (error) handleError('findByClaimCode failed', error);
    return toCamelCaseRecord(data);
  },

  async setSecrets(deviceId, { pollSecret, webhookSecret }) {
    const { error } = await supabase
      .from(TABLE_NAME)
      .update({
        poll_secret: pollSecret,
        webhook_secret: webhookSecret,
        trigger: false,
      })
      .eq('device_id', deviceId);

    if (error) handleError('setSecrets failed', error);
  },

  async setTrigger(deviceId, value) {
    const { error } = await supabase
      .from(TABLE_NAME)
      .update({ trigger: value })
      .eq('device_id', deviceId);

    if (error) handleError('setTrigger failed', error);
  },
};

module.exports = deviceStore;

