const { pool }               = require('../config/db');
const { getRedis }           = require('../config/redis');
const { broadcastToMachine } = require('./websocketService');
const { createError }        = require('../middleware/errorHandler');

const SEVERITY_LEVELS = ['INFO', 'WARNING', 'CRITICAL'];

// ─── Create a new alarm ───────────────────────────────
const createAlarm = async ({ siteId, lineId, machineId, alarmCode, message, severity }) => {
  if (!SEVERITY_LEVELS.includes(severity)) {
    throw createError(`Invalid severity. Must be: ${SEVERITY_LEVELS.join(', ')}`, 400);
  }

  const { rows } = await pool.query(
    `INSERT INTO alarms (site_id, line_id, machine_id, alarm_code, message, severity, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', NOW())
     RETURNING *`,
    [siteId, lineId, machineId, alarmCode, message || null, severity]
  );

  const alarm = rows[0];

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(`alarm:active:${machineId}`, 'true');
    } catch (e) {}
  }

  broadcastToMachine(machineId, {
    type: 'alarm',
    data: {
      alarmId:   alarm.id,
      alarmCode: alarm.alarm_code,
      message:   alarm.message,
      severity:  alarm.severity,
      status:    'ACTIVE',
      timestamp: alarm.created_at,
    },
  });

  return alarm;
};

// ─── Get alarms for a machine ─────────────────────────
const getAlarms = async (machineId, { status, limit } = {}) => {
  let query  = `SELECT * FROM alarms WHERE machine_id = $1`;
  const args = [machineId];
  let idx    = 2;

  if (status) {
    query += ` AND status = $${idx++}`;
    args.push(status.toUpperCase());
  }

  query += ` ORDER BY created_at DESC LIMIT $${idx}`;
  args.push(limit || 50);

  const { rows } = await pool.query(query, args);
  return rows;
};

// ─── Acknowledge an alarm ─────────────────────────────
const acknowledgeAlarm = async (alarmId, acknowledgedBy) => {
  const { rows } = await pool.query(
    `UPDATE alarms
     SET status = 'ACKNOWLEDGED', acknowledged_by = $1, acknowledged_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [acknowledgedBy, alarmId]
  );

  if (rows.length === 0) throw createError('Alarm not found', 404);

  const alarm = rows[0];

  const { rows: activeAlarms } = await pool.query(
    `SELECT id FROM alarms WHERE machine_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [alarm.machine_id]
  );

  if (activeAlarms.length === 0) {
    const redis = getRedis();
    if (redis) {
      try {
        await redis.del(`alarm:active:${alarm.machine_id}`);
      } catch (e) {}
    }

    broadcastToMachine(alarm.machine_id, {
      type: 'alarm_cleared',
      data: { machineId: alarm.machine_id },
    });
  }

  return alarm;
};

module.exports = { createAlarm, getAlarms, acknowledgeAlarm };