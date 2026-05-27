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
      const data = JSON.parse(msg.payload);

      const formatted = {
        machineId:          data.machine_id,
        siteId:             data.site_id,
        lineId:             data.line_id,
        ts:                 data.ts,
        deviceUptimeMs:     data.device_uptime_ms,
        canNodeId:          data.can_node_id,
        canState:           data.can_state,
        statusWord:         data.status_word,
        errorCode:          data.error_code,
        statusFlags:        data.status_flags,
        operationEnabled:   data.operation_enabled,
        faultActive:        data.fault_active,
        warningActive:      data.warning_active,
        remoteActive:       data.remote_active,
        modeDisplay:        data.mode_display,
        rpdoRxCounter:      data.rpdo_rx_counter,
        telemetryTxCounter: data.telemetry_tx_counter,
        // Multi-servo array — present when ESP32 sends drive-level breakdown
        servos:             data.servos ?? null,
        // Real output cycle counter from PLC (replaces frontend-estimated counter)
        cycleCount:         data.cycle_count ?? null,
      };

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

  const r = rows[0];
  return {
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
    // Multi-servo array — present when ESP32 sends drive-level breakdown
    servos:             r.servos ?? null,
    // Real output cycle counter from PLC
    cycleCount:         r.cycle_count ?? null,
  };
};

/* ───────────────────────────────────────────────────────────
   Historical data — returns camelCase (consistent with getLatestTelemetry)
   ─────────────────────────────────────────────────────────── */
const mapRow = (r) => ({
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
  servos:             r.servos     ?? null,
  cycleCount:         r.cycle_count ?? null,
});

const getTelemetryHistory = async ({ machineId, from, to, limit }) => {
  let query  = `SELECT * FROM telemetry WHERE machine_id = $1`;
  const args = [machineId];
  let idx    = 2;

  if (from) { query += ` AND ts >= $${idx++}`; args.push(from); }
  if (to)   { query += ` AND ts <= $${idx++}`; args.push(to); }

  query += ` ORDER BY ts DESC LIMIT $${idx}`;
  args.push(limit);

  const { rows } = await pool.query(query, args);
  return rows.map(mapRow);
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
};