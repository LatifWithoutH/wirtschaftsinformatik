// utils/auditLogger.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function logAudit({ action, tableName, recordId = null, recordName = null, oldData = null, newData = null, user = null, req = null }) {
  try {
    const ipAddress = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : null;
    const userAgent = req ? req.headers['user-agent'] : null;

    const { error } = await supabase.from('audit_logs').insert({
      user_id: user?.id || null,
      user_email: user?.email || 'system',
      user_role: user?.role || 'system',
      action: action.toUpperCase(),
      table_name: tableName,
      record_id: recordId,
      record_name: recordName,
      old_data: oldData,
      new_data: newData,
      ip_address: ipAddress,
      user_agent: userAgent
    });

    if (error) console.error('❌ Audit log error:', error);
  } catch (err) {
    console.error('❌ Audit logger crash:', err);
    // Jangan throw - biar sistem tetap jalan
  }
}

module.exports = { logAudit };
