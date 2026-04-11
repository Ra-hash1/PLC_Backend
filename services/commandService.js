const { pool }               = require('../config/db');
const { getRedis }           = require('../config/redis');
const { broadcastToMachine } = require('./websocketService');
const { createError }        = require('../middleware/errorHandler');
const logger                 = require('../utils/logger');

// ✅ Safe fetch (Node 16 + 18 support)
const fetchFn = global.fetch || require('node-fetch');

// ✅ Correct Lambda URL (with fallback FIXED)
const LAMBDA_URL =
  process.env.LAMBDA_COMMAND_URL ||
  'https://k2mpfkm9q4.execute-api.ap-south-1.amazonaws.com/commands';

// ─────────────────────────────────────────────────────
// 🚀 Send a command to a PLC machine
// ─────────────────────────────────────────────────────
const sendCommand = async ({
  siteId,
  lineId,
  machineId,
  command,
  params = {},
  issuedBy
}) => {
  const timestamp = new Date().toISOString();

  // ─── 1. Persist to PostgreSQL ───────────────────────
  const { rows: inserted } = await pool.query(
    `INSERT INTO commands (machine_id, command, params, issued_by, status, created_at)
     VALUES ($1, $2, $3, $4, 'SENT', $5)
     RETURNING command_id`,
    [machineId, command, JSON.stringify(params), issuedBy || null, timestamp]
  );

  const commandId = inserted[0].command_id;

  let lambdaData;

  // ─── 2. Call AWS Lambda (with timeout) ──────────────
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const lambdaRes = await fetchFn(LAMBDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, lineId, machineId, command, params }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const raw = await lambdaRes.text();
    logger.info(`Lambda raw response [${lambdaRes.status}]: ${raw}`);

    // ─── Parse JSON safely ────────────────────────────
    try {
      lambdaData = JSON.parse(raw);
    } catch {
      await pool.query(
        `UPDATE commands SET status = 'FAILED' WHERE command_id = $1`,
        [commandId]
      );
      throw createError(`Lambda returned non-JSON: ${raw}`, 502);
    }

    // ─── Handle HTTP errors ───────────────────────────
    if (!lambdaRes.ok) {
      await pool.query(
        `UPDATE commands SET status = 'FAILED' WHERE command_id = $1`,
        [commandId]
      );

      // ── Broadcast failure status so clients know ────
      broadcastToMachine(machineId, {
        type:   'machine_status',
        status: 'error',
        reason: lambdaData?.error || lambdaData?.message || `Lambda HTTP ${lambdaRes.status}`,
      });

      throw createError(
        lambdaData?.error ||
        lambdaData?.message ||
        `Lambda HTTP ${lambdaRes.status}`,
        502
      );
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      logger.error('Lambda request timed out');
      await pool.query(
        `UPDATE commands SET status = 'FAILED' WHERE command_id = $1`,
        [commandId]
      );
      throw createError('Lambda request timeout', 504);
    }

    if (err.status) throw err;

    logger.error('Lambda fetch failed:', err.message);

    await pool.query(
      `UPDATE commands SET status = 'FAILED' WHERE command_id = $1`,
      [commandId]
    ).catch(() => {});

    throw createError(`Cannot reach Lambda: ${err.message}`, 502);
  }

  // ─── 3. Derive topic ────────────────────────────────
  const topic =
    lambdaData?.topic ||
    `factory/${siteId}/${lineId}/${machineId}/cmd`;

  logger.info(`Command [${command}] → ${topic} | ID: ${commandId}`);

  // ─── 4. Update DB status ────────────────────────────
  await pool.query(
    `UPDATE commands SET status = 'PUBLISHED' WHERE command_id = $1`,
    [commandId]
  ).catch(e => logger.warn('DB update failed:', e.message));

  // ─── 5. Derive the new machine status from the command ──
  //   Lambda may return machineStatus explicitly; if not, derive it
  //   from the command so the UI updates immediately without a DB round-trip.
  const derivedStatus =
    lambdaData?.machineStatus ||
    (command === 'start' ? 'running'  :
     command === 'stop'  ? 'stopped'  :
     command === 'reset' ? 'stopped'  : null);

  const payload = {
    commandId,
    siteId,
    lineId,
    machineId,
    command,
    params,
    issuedBy: issuedBy || null,
    timestamp,
    machineStatus: lambdaData?.machineStatus || null,
    message: lambdaData?.message || null
  };

  // ─── 6. Cache in Redis ──────────────────────────────
  const redis = getRedis();
  if (redis) {
    try {
      await redis.setEx(
        `cmd:latest:${machineId}`,
        3600,
        JSON.stringify(payload)
      );
    } catch (e) {
      logger.warn('Redis setEx failed:', e.message);
    }
  }

  // ─── 7. Broadcast command_issued (existing) ─────────
  broadcastToMachine(machineId, {
    type: 'command_issued',
    data: payload
  });

  // ─── 8. Broadcast machine_status so all WS clients   ─
  //        update their Remote Control panel immediately ─
  //        without any HTTP polling or manual refresh.   ─
  if (derivedStatus) {
    broadcastToMachine(machineId, {
      type:   'machine_status',
      status: derivedStatus,         // e.g. 'running' | 'stopped'
      source: 'command',             // lets the client distinguish origin
      commandId,
    });
    logger.info(`Broadcasted machine_status [${derivedStatus}] for machine: ${machineId}`);
  }

  // ─── 9. Return response ─────────────────────────────
  return {
    commandId,
    topic,
    timestamp,
    machineStatus: lambdaData?.machineStatus,
    message: lambdaData?.message
  };
};

// ─────────────────────────────────────────────────────
// 📜 Fetch command history
// ─────────────────────────────────────────────────────
const getCommandHistory = async (machineId, limit = 50) => {
  const { rows } = await pool.query(
    `SELECT *
     FROM commands
     WHERE machine_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [machineId, limit]
  );
  return rows;
};

module.exports = {
  sendCommand,
  getCommandHistory
};