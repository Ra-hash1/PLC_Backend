const { pool }               = require('../config/db');
const { getRedis }           = require('../config/redis');
const { broadcastTelemetry } = require('./websocketService');
const logger                 = require('../utils/logger');

// Dedicated client for the LISTEN connection — held for the process lifetime
let _listenerClient = null;

/* ───────────────────────────────────────────────────────────
   DB LISTEN → WebSocket broadcast
   Telemetry rows are inserted directly by the ESP32 / IoT pipeline.
   This listener picks up each INSERT via PostgreSQL NOTIFY and
   pushes the data to connected WS clients in real-time.
   ─────────────────────────────────────────────────────────── */
const startTelemetryListener = async () => {
  const client = await pool.connect();
  _listenerClient = client;
  await client.query('LISTEN telemetry_channel');
  logger.info('Listening to PostgreSQL channel: telemetry_channel');

  client.on('notification', async (msg) => {
    try {
      // NOTIFY payload is now minimal: { id, machine_id, site_id, line_id, ts }
      // (migration v6 — prevents "payload string too long" when servos/canopen_nodes
      //  are large; JSONB arrays stay in the DB row and are fetched by PK below)
      const hint = JSON.parse(msg.payload);
      const rowId = hint.id;
      if (!rowId) throw new Error('NOTIFY missing row id');

      // Fetch the full row — single PK lookup, extremely fast
      const { rows } = await pool.query(
        'SELECT * FROM telemetry WHERE id = $1',
        [rowId]
      );
      if (!rows.length) return; // row disappeared (shouldn't happen)

      const formatted = mapRow(rows[0]);

      // Update Redis cache
      const redis = getRedis();
      if (redis) {
        try {
          await redis.setEx(
            `telemetry:latest:${formatted.machineId}`,
            300,
            JSON.stringify(formatted)
          );
        } catch (e) {
          logger.warn('Redis update failed:', e.message);
        }
      }

      broadcastTelemetry(formatted.machineId, formatted);

    } catch (err) {
      logger.error('Telemetry listener parse error:', err.message);
    }
  });
};

/* ───────────────────────────────────────────────────────────
   Latest snapshot — Redis first, DB fallback
   ─────────────────────────────────────────────────────────── */
const getLatestTelemetry = async (machineId) => {
  const redis = getRedis();

  if (redis) {
    try {
      const raw = await redis.get(`telemetry:latest:${machineId}`);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      logger.warn('Redis get failed, falling back to DB:', e.message);
    }
  }

  const { rows } = await pool.query(
    `SELECT * FROM telemetry WHERE machine_id = $1 ORDER BY ts DESC LIMIT 1`,
    [machineId]
  );

  if (!rows.length) return null;

  return mapRow(rows[0]);
};

/* ───────────────────────────────────────────────────────────
   Historical data — returns camelCase (consistent with getLatestTelemetry)
   ─────────────────────────────────────────────────────────── */
const mapRow = (r) => ({
  id:                 r.id,           // SERIAL PK — used as export cursor
  machineId:          r.machine_id,
  siteId:             r.site_id,
  lineId:             r.line_id,
  ts:                 r.ts,
  deviceUptimeMs:     r.device_uptime_ms,
  canNodeId:          r.can_node_id,
  canState:           r.can_state,
  statusWord:         r.status_word,
  errorCode:          r.error_code,
  statusFlags:        r.status_flags,
  operationEnabled:   r.operation_enabled,
  faultActive:        r.fault_active,
  warningActive:      r.warning_active,
  remoteActive:       r.remote_active,
  modeDisplay:        r.mode_display,
  rpdoRxCounter:      r.rpdo_rx_counter,
  telemetryTxCounter: r.telemetry_tx_counter,
  servos:             r.servos        ?? null,
  cycleCount:         r.cycle_count   ?? null,
  // Primary drive actual current (Amps)
  currentActual:      r.current_actual != null ? Number(r.current_actual) : null,
  // PLC-native state flags
  plcFeedbackFresh:       r.plc_feedback_fresh       ?? null,
  machineReadyToRun:      r.machine_ready_to_run     ?? null,
  machineActuallyRunning: r.machine_actually_running ?? null,
  machineFaulted:         r.machine_faulted          ?? null,
  machineStopping:        r.machine_stopping         ?? null,
  machineDisabled:        r.machine_disabled         ?? null,
  remoteStartAllowed:     r.remote_start_allowed     ?? null,
  axisErrorId:            r.axis_error_id            ?? null,
  diagnosticWord:         r.diagnostic_word          ?? null,
  // Production counters (snapshot at row time)
  totalRuntimeSeconds:    r.total_runtime_seconds    != null ? Number(r.total_runtime_seconds)   : null,
  sessionRuntimeSeconds:  r.session_runtime_seconds  != null ? Number(r.session_runtime_seconds) : null,
  totalPouches:           r.total_pouches            != null ? Number(r.total_pouches)           : null,
  sessionPouches:         r.session_pouches          != null ? Number(r.session_pouches)         : null,
  pouchCounter:           r.pouch_counter            != null ? Number(r.pouch_counter)           : null,
  productionRatePpm:      r.production_rate_ppm      != null ? Number(r.production_rate_ppm)     : null,
  // CANopen network topology and full raw payload (migration v5)
  canopenNodes: Array.isArray(r.canopen_nodes) ? r.canopen_nodes : [],
  rawPayload:   r.raw_payload   ?? null,
});

const getTelemetryHistory = async ({ machineId, from, to, limit, offset = 0, afterId = null }) => {
  let query  = `SELECT * FROM telemetry WHERE machine_id = $1`;
  const args = [machineId];
  let idx    = 2;

  if (from)         { query += ` AND ts >= $${idx++}`;  args.push(from); }
  if (to)           { query += ` AND ts <= $${idx++}`;  args.push(to); }
  if (afterId != null) { query += ` AND id > $${idx++}`; args.push(afterId); }

  if (afterId != null) {
    // Cursor mode (export): stable chronological order via PK — immune to concurrent inserts
    query += ` ORDER BY id ASC LIMIT $${idx}`;
    args.push(limit);
  } else {
    // Default mode (dashboard): newest-first with offset
    query += ` ORDER BY ts DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    args.push(limit, offset);
  }

  const { rows } = await pool.query(query, args);
  return rows.map(mapRow);
};

const getTelemetryCount = async ({ machineId, from, to }) => {
  let query  = `SELECT COUNT(*) FROM telemetry WHERE machine_id = $1`;
  const args = [machineId];
  let idx    = 2;

  if (from) { query += ` AND ts >= $${idx++}`; args.push(from); }
  if (to)   { query += ` AND ts <= $${idx++}`; args.push(to); }

  const { rows } = await pool.query(query, args);
  return parseInt(rows[0].count, 10);
};

/* ───────────────────────────────────────────────────────────
   Graceful shutdown — release the LISTEN client
   ─────────────────────────────────────────────────────────── */
const stopTelemetryListener = async () => {
  if (_listenerClient) {
    try {
      await _listenerClient.query('UNLISTEN telemetry_channel');
      _listenerClient.release();
    } catch (_) { /* ignore — shutting down anyway */ }
    _listenerClient = null;
    logger.info('Telemetry listener stopped');
  }
};

module.exports = {
  startTelemetryListener,
  stopTelemetryListener,
  getLatestTelemetry,
  getTelemetryHistory,
  getTelemetryCount,
};