const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE_NAME = process.env.SUPABASE_DEVICES_TABLE || 'devices';
const TRIGGERS_TABLE_NAME = process.env.SUPABASE_TRIGGERS_TABLE || 'triggers';

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
    patternId: row.pattern_id,
    webhookUrl: row.webhook_url,
    claimLookupUrl: row.claim_lookup_url,
  };
};

const toCamelCaseTriggerRecord = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    deviceId: row.device_id,
    triggeredAt: row.triggered_at,
    createdAt: row.created_at,
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

  async setSecrets(deviceId, { pollSecret, webhookSecret, webhookUrl, claimLookupUrl }) {
    const updateData = {
      poll_secret: pollSecret,
      webhook_secret: webhookSecret,
      trigger: false,
    };
    
    if (webhookUrl !== undefined) {
      updateData.webhook_url = webhookUrl;
    }
    
    if (claimLookupUrl !== undefined) {
      updateData.claim_lookup_url = claimLookupUrl;
    }

    const { error } = await supabase
      .from(TABLE_NAME)
      .update(updateData)
      .eq('device_id', deviceId);

    if (error) handleError('setSecrets failed', error);
  },

  async setTrigger(deviceId, value, patternId) {
    const updateData = { trigger: value };
    if (patternId !== undefined) {
      updateData.pattern_id = patternId;
    }

    const { error } = await supabase
      .from(TABLE_NAME)
      .update(updateData)
      .eq('device_id', deviceId);

    if (error) handleError('setTrigger failed', error);
  },

  async createTrigger(deviceId, patternId) {
    const triggerData = {
      device_id: deviceId,
      triggered_at: new Date().toISOString(),
    };
    if (patternId !== undefined) {
      triggerData.pattern_id = patternId;
    }

    const { data, error } = await supabase
      .from(TRIGGERS_TABLE_NAME)
      .insert(triggerData)
      .select()
      .single();

    if (error) handleError('createTrigger failed', error);
    return toCamelCaseTriggerRecord(data);
  },

  async getTriggersByDeviceId(deviceId, limit = 100) {
    const { data, error } = await supabase
      .from(TRIGGERS_TABLE_NAME)
      .select('*')
      .eq('device_id', deviceId)
      .order('triggered_at', { ascending: false })
      .limit(limit);

    if (error) handleError('getTriggersByDeviceId failed', error);
    return (data || []).map(toCamelCaseTriggerRecord);
  },

  async getAllTriggers(limit = 100) {
    const { data, error } = await supabase
      .from(TRIGGERS_TABLE_NAME)
      .select('*')
      .order('triggered_at', { ascending: false })
      .limit(limit);

    if (error) handleError('getAllTriggers failed', error);
    return (data || []).map(toCamelCaseTriggerRecord);
  },

  async listAll(limit = 100) {
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) handleError('listAll failed', error);
    return (data || []).map(toCamelCaseRecord);
  },

  async backfillUrls(baseUrl) {
    // Get all devices
    const { data: allDevices, error: fetchError } = await supabase
      .from(TABLE_NAME)
      .select('device_id, claim_code, webhook_url, claim_lookup_url');

    if (fetchError) handleError('backfillUrls fetch failed', fetchError);

    // Filter devices that are missing webhook_url or claim_lookup_url
    const devices = (allDevices || []).filter(
      (device) => !device.webhook_url || !device.claim_lookup_url
    );

    if (!devices || devices.length === 0) {
      return { updated: 0, total: 0 };
    }

    let updated = 0;
    const errors = [];

    for (const device of devices) {
      const webhookUrl = `${baseUrl}/api/device/webhook/${device.device_id}`;
      const claimLookupUrl = `${baseUrl}/link?claim=${device.claim_code}`;

      const updateData = {};
      if (!device.webhook_url) {
        updateData.webhook_url = webhookUrl;
      }
      if (!device.claim_lookup_url) {
        updateData.claim_lookup_url = claimLookupUrl;
      }

      const { error: updateError } = await supabase
        .from(TABLE_NAME)
        .update(updateData)
        .eq('device_id', device.device_id);

      if (updateError) {
        errors.push({ device_id: device.device_id, error: updateError.message });
      } else {
        updated++;
      }
    }

    if (errors.length > 0) {
      console.warn('Some devices failed to backfill:', errors);
    }

    return { updated, total: devices.length, errors: errors.length > 0 ? errors : undefined };
  },

  async updateUrls(deviceId, baseUrl) {
    const record = await this.getByDeviceId(deviceId);
    if (!record) {
      throw new Error('Device not found');
    }

    const webhookUrl = `${baseUrl}/api/device/webhook/${deviceId}`;
    const claimLookupUrl = `${baseUrl}/link?claim=${record.claimCode}`;

    const updateData = {};
    if (!record.webhookUrl) {
      updateData.webhook_url = webhookUrl;
    }
    if (!record.claimLookupUrl) {
      updateData.claim_lookup_url = claimLookupUrl;
    }

    if (Object.keys(updateData).length === 0) {
      return; // URLs already exist
    }

    const { error } = await supabase
      .from(TABLE_NAME)
      .update(updateData)
      .eq('device_id', deviceId);

    if (error) handleError('updateUrls failed', error);
  },
};

module.exports = deviceStore;

