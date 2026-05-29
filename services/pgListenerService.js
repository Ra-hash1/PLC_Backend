// services/pgListenerService.js
const { Client } = require('pg');
const { pool }   = require('../config/db');
const { broadcastToMachine } = require('./websocketService');
const logger                 = require('../utils/logger');
const {
  computeSessionRuntimeSeconds,
  computeSessionPouches,
  computeProductionRatePpm,
} = require('../utils/sessionMath');

let listenerClient = null;
let reconnectTimer = null;
let sessionTick    = null;

const SESSION_TICK_MS = 10_000;

// ── In-memory session map ──────────────────────────────────────────────────────
// machineId → { startAt: Date, lastPouchCounter: number }
const activeSessions = new Map();

// ── DB client config ───────────────────────────────────────────────────────────
const getClientConfig = () => ({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'plc_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false,
});

// ── Session transition: machine started running ────────────────────────────────
const handleRunningTransition = async (machineId) => {
  try {
    const { rows } = await pool.query(
      `SELECT pouch_counter FROM machine_state WHERE machine_id = $1`,
      [machineId]
    );
    const lastPouchCounter = rows[0] ? Number(rows[0].pouch_counter) || 0 : 0;
    const startAt          = new Date();

    // Write DB first — set activeSessions only on success to avoid
    // leaving in-memory state inconsistent with DB if the write fails.
    await pool.query(
      `UPDATE machine_state
       SET session_start_at        = $1,
           session_runtime_seconds = 0,
           session_pouches         = 0,
           production_rate_ppm     = 0
       WHERE machine_id = $2`,
      [startAt.toISOString(), machineId]
    );
    activeSessions.set(machineId, { startAt, lastPouchCounter });
    logger.info(`Session started: machine [${machineId}] pouchBase=${lastPouchCounter}`);
  } catch (err) {
    logger.error(`handleRunningTransition [${machineId}]:`, err.message);
  }
};

// ── Session transition: machine stopped ───────────────────────────────────────
const handleStopTransition = async (machineId) => {
  const session = activeSessions.get(machineId);
  if (!session) return;
  activeSessions.delete(machineId);

  try {
    const { rows } = await pool.query(
      `SELECT pouch_counter, session_runtime_seconds FROM machine_state WHERE machine_id = $1`,
      [machineId]
    );
    if (!rows[0]) return;

    // Guard against rapid stop→start race: if a new session was installed
    // while we were awaiting the DB read, skip accumulating totals for this
    // stale stop so we don't corrupt the freshly-started session's data.
    if (activeSessions.has(machineId)) {
      logger.info(`Session ended: machine [${machineId}] — new session already started, skipping total accumulation`);
      return;
    }

    const currentCounter = Number(rows[0].pouch_counter)           || 0;
    const sessionPouches = computeSessionPouches(currentCounter, session.lastPouchCounter);
    const sessionSeconds = Number(rows[0].session_runtime_seconds) || 0;

    await pool.query(
      `UPDATE machine_state
       SET total_runtime_seconds = total_runtime_seconds + $1,
           total_pouches         = total_pouches + $2,
           session_start_at      = NULL
       WHERE machine_id = $3`,
      [sessionSeconds, sessionPouches, machineId]
    );
    logger.info(`Session ended: machine [${machineId}] +${sessionSeconds}s +${sessionPouches} pouches`);
  } catch (err) {
    logger.error(`handleStopTransition [${machineId}]:`, err.message);
  }
};

// ── 10-second tick: update live session counters ──────────────────────────────
const tickAllSessions = async () => {
  if (activeSessions.size === 0) return;

  const now = Date.now();

  // Snapshot entries before iterating — guards against activeSessions being
  // mutated by a notification while we are suspended at an await.
  for (const [machineId, session] of [...activeSessions.entries()]) {
    try {
      const { rows } = await pool.query(
        `SELECT pouch_counter FROM machine_state WHERE machine_id = $1`,
        [machineId]
      );
      if (!rows[0]) continue;

      const currentCounter = Number(rows[0].pouch_counter) || 0;
      const sessionSeconds = computeSessionRuntimeSeconds(session.startAt, now);
      const sessionPouches = computeSessionPouches(currentCounter, session.lastPouchCounter);
      const ratePpm        = computeProductionRatePpm(sessionPouches, sessionSeconds);

      await pool.query(
        `UPDATE machine_state
         SET session_runtime_seconds = $1,
             session_pouches         = $2,
             production_rate_ppm     = $3
         WHERE machine_id = $4`,
        [sessionSeconds, sessionPouches, ratePpm, machineId]
      );
    } catch (err) {
      logger.error(`tickAllSessions [${machineId}]:`, err.message);
    }
  }
};

// ── Startup recovery: re-hydrate activeSessions from DB ───────────────────────
const recoverSessions = async () => {
  try {
    const { rows } = await pool.query(
      `SELECT machine_id, session_start_at, pouch_counter, session_pouches
       FROM machine_state
       WHERE machine_actually_running = true AND session_start_at IS NOT NULL`
    );

    if (rows.length === 0) {
      logger.info('recoverSessions: no active sessions found');
      return;
    }

    rows.forEach(r => {
      const currentCounter = Number(r.pouch_counter)   || 0;
      const alreadyCounted = Number(r.session_pouches) || 0;
      // Reconstruct the counter baseline at session start: current minus what
      // was already counted before the restart. This preserves pre-restart
      // production in the next tick's computeSessionPouches call.
      const lastPouchCounter = currentCounter - alreadyCounted;

      activeSessions.set(r.machine_id, {
        startAt:          new Date(r.session_start_at),
        lastPouchCounter: Math.max(0, lastPouchCounter),
      });
      logger.info(`Session recovered: machine [${r.machine_id}] from ${r.session_start_at}`);
    });

    logger.info(`Recovered ${rows.length} active session(s)`);
  } catch (err) {
    logger.error('recoverSessions failed:', err.message);
  }
};

// ── Main listener ─────────────────────────────────────────────────────────────
const startPgListener = async () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Re-hydrate sessions from DB (handles server restarts)
  await recoverSessions();

  // Start session tick once — guard against duplicate intervals on reconnect
  if (!sessionTick) {
    sessionTick = setInterval(tickAllSessions, SESSION_TICK_MS);
  }

  listenerClient = new Client(getClientConfig());

  listenerClient.on('error', (err) => {
    logger.error('PG listener error:', err.message);
    scheduleReconnect();
  });

  listenerClient.on('end', () => {
    logger.warn('PG listener connection ended');
    scheduleReconnect();
  });

  listenerClient.on('notification', (n) => {
    try {
      const payload = JSON.parse(n.payload);
      const { machineId, status, ts } = payload;

      // Warn once if PLC flags are absent from payload.
      // Fix: re-run `node scripts/install_machine_state_triggers.js` to replace the trigger.
      if (payload.machineActuallyRunning === undefined) {
        logger.warn(`machine [${machineId}] trigger payload missing PLC flags — re-run scripts/install_machine_state_triggers.js`);
      }

      // Broadcast to WS clients — includes PLC state flags (null when trigger
      // hasn't been updated yet to include them)
      broadcastToMachine(machineId, {
        type:   'machine_status',
        status,
        ts,
        source: 'db_trigger',
        plcFeedbackFresh:       payload.plcFeedbackFresh       ?? null,
        machineReadyToRun:      payload.machineReadyToRun      ?? null,
        machineActuallyRunning: payload.machineActuallyRunning ?? null,
        machineFaulted:         payload.machineFaulted         ?? null,
        machineStopping:        payload.machineStopping        ?? null,
        machineDisabled:        payload.machineDisabled        ?? null,
        remoteStartAllowed:     payload.remoteStartAllowed     ?? null,
      });

      logger.info(`DB trigger → machine [${machineId}] status: ${status}`);

      // Session transition detection
      const nowRunning = payload.machineActuallyRunning === true;
      const wasRunning = activeSessions.has(machineId);

      if (nowRunning && !wasRunning) {
        handleRunningTransition(machineId);
      } else if (!nowRunning && wasRunning) {
        handleStopTransition(machineId);
      }

    } catch (e) {
      logger.error('PG notification parse error:', e.message);
    }
  });

  try {
    await listenerClient.connect();
    await listenerClient.query('LISTEN machine_status_changed');
    logger.info('PG listener ready — watching machine_status_changed');
  } catch (err) {
    logger.error('PG listener connect failed:', err.message);
    scheduleReconnect();
  }
};

const scheduleReconnect = () => {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    logger.info('PG listener reconnecting...');
    startPgListener();
  }, 5000);
};

const stopPgListener = async () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (sessionTick) { clearInterval(sessionTick); sessionTick = null; }
  activeSessions.clear();
  if (listenerClient) {
    await listenerClient.end().catch(() => {});
    listenerClient = null;
  }
};

module.exports = { startPgListener, stopPgListener };
