# Machine State V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 16 new columns to `machine_state`, implement backend session tracking in `pgListenerService`, expose all new fields through the existing API endpoint, and update `LiveView` to display PLC-native state flags, session runtime, and production counters.

**Architecture:** PLC writes state flags + `pouch_counter` directly to `machine_state`; `pgListenerService` detects `machine_actually_running` transitions, maintains an in-memory `activeSessions` map, and ticks every 10 s to write `session_runtime_seconds / session_pouches / production_rate_ppm` back to DB. Frontend receives state flags instantly via WebSocket, polls counters every 3 s via the existing `/dashboard/machine/:id` endpoint.

**Tech Stack:** PostgreSQL, Node.js (`pg`, `ws`), React 18, Vite

**Spec:** `docs/superpowers/specs/2026-05-26-machine-state-v2-design.md`

---

## File Map

| File | Repo | Action |
|------|------|--------|
| `scripts/migrate_machine_state_v2.js` | backend | **Create** |
| `scripts/update_machine_state_trigger.js` | backend | **Create** |
| `utils/sessionMath.js` | backend | **Create** |
| `tests/utils/sessionMath.test.js` | backend | **Create** |
| `tests/services/machineService.test.js` | backend | **Create** |
| `services/machineService.js` | backend | **Modify** |
| `services/pgListenerService.js` | backend | **Modify** |
| `src/hooks/useWebSocket.js` | frontend | **Modify** |
| `src/components/LiveView.jsx` | frontend | **Modify** |

---

## Task 1: DB Migration Script

**Files:**
- Create: `scripts/migrate_machine_state_v2.js`

- [ ] **Step 1: Create the migration script**

```js
// scripts/migrate_machine_state_v2.js
// Idempotent — safe to run multiple times.
require('dotenv').config();
const { pool } = require('../config/db');

const COLUMNS = [
  { name: 'plc_feedback_fresh',        def: 'BOOLEAN' },
  { name: 'machine_ready_to_run',      def: 'BOOLEAN' },
  { name: 'machine_actually_running',  def: 'BOOLEAN' },
  { name: 'machine_faulted',           def: 'BOOLEAN' },
  { name: 'machine_stopping',          def: 'BOOLEAN' },
  { name: 'machine_disabled',          def: 'BOOLEAN' },
  { name: 'remote_start_allowed',      def: 'BOOLEAN' },
  { name: 'axis_error_id',             def: 'INTEGER' },
  { name: 'diagnostic_word',           def: 'INTEGER' },
  { name: 'pouch_counter',             def: 'NUMERIC(14,2) DEFAULT 0' },
  { name: 'session_pouches',           def: 'NUMERIC(14,2) DEFAULT 0' },
  { name: 'total_pouches',             def: 'NUMERIC(14,2) DEFAULT 0' },
  { name: 'session_runtime_seconds',   def: 'BIGINT DEFAULT 0' },
  { name: 'total_runtime_seconds',     def: 'BIGINT DEFAULT 0' },
  { name: 'production_rate_ppm',       def: 'NUMERIC(10,2) DEFAULT 0' },
  { name: 'session_start_at',          def: 'TIMESTAMPTZ' },
];

async function run() {
  console.log('Checking machine_state columns…\n');

  const { rows: existing } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'machine_state'
  `);
  const existingSet = new Set(existing.map(r => r.column_name));

  for (const col of COLUMNS) {
    if (existingSet.has(col.name)) {
      console.log(`  ✓  ${col.name.padEnd(30)} already exists`);
      continue;
    }
    await pool.query(`ALTER TABLE machine_state ADD COLUMN ${col.name} ${col.def}`);
    console.log(`  ✚  ${col.name.padEnd(30)} added`);
  }

  console.log('\nMigration complete.');
}

run()
  .catch(e => { console.error('Migration failed:', e.message); process.exit(1); })
  .finally(() => pool.end());
```

- [ ] **Step 2: Run the migration**

```bash
cd plc-backend
node scripts/migrate_machine_state_v2.js
```

Expected output — each column either `✓ already exists` or `✚ added`.  
If you see `Migration failed:` check your `.env` DB credentials.

- [ ] **Step 3: Verify columns exist**

```bash
node scripts/check_schema.js
```

Confirm `machine_state` now has `plc_feedback_fresh`, `machine_ready_to_run`, `session_runtime_seconds`, etc. in the output.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate_machine_state_v2.js
git commit -m "feat(db): add machine_state v2 migration script (16 new columns)"
```

---

## Task 2: DB Trigger Inspection Script

**Files:**
- Create: `scripts/update_machine_state_trigger.js`

The `machine_status_changed` trigger fires on every `machine_state` UPDATE and sends a NOTIFY payload. We cannot auto-apply the trigger (its body is in the live DB), but we can print the current body and the exact diff needed.

- [ ] **Step 1: Create the inspection script**

```js
// scripts/update_machine_state_trigger.js
require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  console.log('=== Searching for machine_status_changed trigger function ===\n');

  const { rows } = await pool.query(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    WHERE pg_get_functiondef(p.oid) ILIKE '%machine_status_changed%'
  `);

  if (rows.length === 0) {
    console.log('No trigger function referencing machine_status_changed found.');
    console.log('Check DB manually: SELECT * FROM pg_trigger WHERE tgname ILIKE \'%machine%\';');
  } else {
    rows.forEach(r => {
      console.log(`Function: ${r.proname}\n`);
      console.log(r.def);
    });
  }

  console.log('\n=== REQUIRED CHANGE TO THE NOTIFY PAYLOAD ===');
  console.log('Find the json_build_object(...) call in your trigger function.');
  console.log('Add these key-value pairs to it:\n');
  console.log(`
  'plcFeedbackFresh',       NEW.plc_feedback_fresh,
  'machineReadyToRun',      NEW.machine_ready_to_run,
  'machineActuallyRunning', NEW.machine_actually_running,
  'machineFaulted',         NEW.machine_faulted,
  'machineStopping',        NEW.machine_stopping,
  'machineDisabled',        NEW.machine_disabled,
  'remoteStartAllowed',     NEW.remote_start_allowed
  `);
  console.log('Apply the updated CREATE OR REPLACE FUNCTION ... in your DB client (psql / pgAdmin).');
}

run()
  .catch(e => { console.error(e.message); process.exit(1); })
  .finally(() => pool.end());
```

- [ ] **Step 2: Run the script and note the current trigger body**

```bash
node scripts/update_machine_state_trigger.js
```

Copy the printed function definition. Open your DB client (psql/pgAdmin) and apply the updated trigger with the new boolean fields added to the `json_build_object` as shown.

- [ ] **Step 3: Commit the script**

```bash
git add scripts/update_machine_state_trigger.js
git commit -m "feat(db): add trigger inspection script for machine_status_changed payload"
```

---

## Task 3: Session Math Utilities + Tests

**Files:**
- Create: `utils/sessionMath.js`
- Create: `tests/utils/sessionMath.test.js`

These are pure functions — no DB, no side effects. Write the test first.

- [ ] **Step 1: Write the failing tests**

Create `tests/utils/sessionMath.test.js`:

```js
// tests/utils/sessionMath.test.js
const {
  computeSessionRuntimeSeconds,
  computeSessionPouches,
  computeProductionRatePpm,
} = require('../../utils/sessionMath');

describe('computeSessionRuntimeSeconds', () => {
  test('returns correct integer seconds for elapsed time', () => {
    const startAt = new Date(1000);   // 1 s into epoch
    const now     = 61_000;           // 61 s into epoch
    expect(computeSessionRuntimeSeconds(startAt, now)).toBe(60);
  });

  test('returns 0 when now is before startAt', () => {
    const startAt = new Date(5000);
    expect(computeSessionRuntimeSeconds(startAt, 3000)).toBe(0);
  });

  test('truncates fractional seconds — does not round up', () => {
    const startAt = new Date(0);
    expect(computeSessionRuntimeSeconds(startAt, 1999)).toBe(1);
  });
});

describe('computeSessionPouches', () => {
  test('normal increment', () => {
    expect(computeSessionPouches(150, 100)).toBe(50);
  });

  test('returns 0 when counters are equal', () => {
    expect(computeSessionPouches(100, 100)).toBe(0);
  });

  test('counter reset/wrap: current < last → uses current as delta', () => {
    expect(computeSessionPouches(20, 9000)).toBe(20);
  });

  test('never returns negative', () => {
    expect(computeSessionPouches(0, 0)).toBe(0);
  });
});

describe('computeProductionRatePpm', () => {
  test('60 pouches in 60 s = 60.00 ppm', () => {
    expect(computeProductionRatePpm(60, 60)).toBe(60);
  });

  test('returns 0 when sessionRuntimeSeconds is 0', () => {
    expect(computeProductionRatePpm(100, 0)).toBe(0);
  });

  test('200 pouches in 60 s = 200.00 ppm', () => {
    expect(computeProductionRatePpm(200, 60)).toBe(200);
  });

  test('fractional result rounded to 2 decimal places', () => {
    // 1 pouch / (7/60) min ≈ 8.57 ppm
    expect(computeProductionRatePpm(1, 7)).toBeCloseTo(8.57, 1);
  });
});
```

- [ ] **Step 2: Run tests — confirm they all FAIL**

```bash
cd plc-backend
npx jest tests/utils/sessionMath.test.js --no-coverage
```

Expected: `Cannot find module '../../utils/sessionMath'`

- [ ] **Step 3: Create the implementation**

Create `utils/sessionMath.js`:

```js
// utils/sessionMath.js
// Pure session calculation utilities — no side effects, safe to unit-test.

/**
 * Seconds elapsed since a session started.
 * @param {Date}   startAt  – when the session began
 * @param {number} now      – current timestamp ms (defaults to Date.now())
 * @returns {number}        – non-negative integer
 */
function computeSessionRuntimeSeconds(startAt, now = Date.now()) {
  return Math.max(0, Math.floor((now - startAt.getTime()) / 1000));
}

/**
 * Pouches produced in the current session.
 * Handles counter wrap/reset: if current < last, treats current as the delta.
 * @param {number} currentCounter – latest raw PLC counter value
 * @param {number} lastCounter    – counter value at session start
 * @returns {number}
 */
function computeSessionPouches(currentCounter, lastCounter) {
  if (currentCounter < lastCounter) {
    // Counter was reset or wrapped — use current value as the production delta
    return Math.max(0, currentCounter);
  }
  return Math.max(0, currentCounter - lastCounter);
}

/**
 * Session-average production rate in pouches per minute.
 * Returns 0 if sessionRuntimeSeconds is 0 to avoid division by zero.
 * @param {number} sessionPouches
 * @param {number} sessionRuntimeSeconds
 * @returns {number}  rounded to 2 decimal places
 */
function computeProductionRatePpm(sessionPouches, sessionRuntimeSeconds) {
  if (sessionRuntimeSeconds <= 0) return 0;
  const ppm = sessionPouches / (sessionRuntimeSeconds / 60);
  return Math.round(ppm * 100) / 100;
}

module.exports = {
  computeSessionRuntimeSeconds,
  computeSessionPouches,
  computeProductionRatePpm,
};
```

- [ ] **Step 4: Run tests — confirm they all PASS**

```bash
npx jest tests/utils/sessionMath.test.js --no-coverage
```

Expected: `Tests: 9 passed, 9 total`

- [ ] **Step 5: Commit**

```bash
git add utils/sessionMath.js tests/utils/sessionMath.test.js
git commit -m "feat(utils): add sessionMath pure functions with tests"
```

---

## Task 4: machineService.js — New Field Mapping

**Files:**
- Modify: `services/machineService.js` (lines 136–160, the `getMachineState` return object)
- Create: `tests/services/machineService.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/services/machineService.test.js`:

```js
// tests/services/machineService.test.js
jest.mock('../config/db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../config/redis', () => ({ getRedis: () => null }));
jest.mock('../middleware/errorHandler', () => ({
  createError: (msg, code) => { const e = new Error(msg); e.status = code; return e; },
}));

const { getMachineState } = require('../../services/machineService');
const { pool }            = require('../../config/db');

const BASE_ROW = {
  machine_id: 'M1', site_id: 'S1', line_id: 'L1',
  status: 'RUNNING', ts: '2026-01-01T00:00:00Z', payload: {},
  plc_feedback_fresh: true,  machine_ready_to_run: true,
  machine_actually_running: true, machine_faulted: false,
  machine_stopping: false,   machine_disabled: false,
  remote_start_allowed: true,
  axis_error_id: 0,          diagnostic_word: 65,
  pouch_counter: '1000.00',  session_pouches: '250.00',
  total_pouches: '5000.00',  session_runtime_seconds: '900',
  total_runtime_seconds: '18000', production_rate_ppm: '16.67',
  session_start_at: '2026-01-01T00:15:00Z',
};

describe('getMachineState — v2 field mapping', () => {
  test('maps all 16 new columns to camelCase with correct types', async () => {
    pool.query.mockResolvedValue({ rows: [BASE_ROW] });
    const result = await getMachineState('M1');

    // PLC state flags
    expect(result.plcFeedbackFresh).toBe(true);
    expect(result.machineReadyToRun).toBe(true);
    expect(result.machineActuallyRunning).toBe(true);
    expect(result.machineFaulted).toBe(false);
    expect(result.machineStopping).toBe(false);
    expect(result.machineDisabled).toBe(false);
    expect(result.remoteStartAllowed).toBe(true);

    // Diagnostics
    expect(result.axisErrorId).toBe(0);
    expect(result.diagnosticWord).toBe(65);

    // Production counters — NUMERIC strings become JS numbers
    expect(result.pouchCounter).toBe(1000);
    expect(result.sessionPouches).toBe(250);
    expect(result.totalPouches).toBe(5000);

    // Runtime counters — BIGINT strings become JS numbers
    expect(result.sessionRuntimeSeconds).toBe(900);
    expect(result.totalRuntimeSeconds).toBe(18000);
    expect(result.productionRatePpm).toBeCloseTo(16.67);
  });

  test('returns null for all new fields when columns are null', async () => {
    const nullRow = Object.fromEntries(
      Object.keys(BASE_ROW).map(k => [k, null])
    );
    nullRow.machine_id = 'M1';
    pool.query.mockResolvedValue({ rows: [nullRow] });

    const result = await getMachineState('M1');

    expect(result.plcFeedbackFresh).toBeNull();
    expect(result.pouchCounter).toBeNull();
    expect(result.sessionRuntimeSeconds).toBeNull();
    expect(result.productionRatePpm).toBeNull();
  });

  test('returns null when machine not found', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = await getMachineState('MISSING');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — confirm they FAIL**

```bash
npx jest tests/services/machineService.test.js --no-coverage
```

Expected: properties like `result.plcFeedbackFresh` are `undefined` (not mapped yet).

- [ ] **Step 3: Update `getMachineState` return object**

In `services/machineService.js`, find the `getMachineState` function (line ~136). Replace the `return { ...row, ... }` block with:

```js
const getMachineState = async (machineId) => {
  const query = `
    SELECT *
    FROM machine_state
    WHERE machine_id = $1
  `;
  const { rows } = await pool.query(query, [machineId]);
  if (!rows[0]) return null;

  const row = rows[0];

  return {
    ...row,

    // ── Existing camelCase aliases ──────────────────────────────────────────
    siteId:     row.site_id    ?? null,
    lineId:     row.line_id    ?? null,
    machineId:  row.machine_id,
    status:     row.status     ?? null,
    lastSeenAt: row.ts ? new Date(row.ts).toISOString() : null,

    // ── NEW: PLC state flags (booleans — written by PLC) ────────────────────
    plcFeedbackFresh:       row.plc_feedback_fresh        ?? null,
    machineReadyToRun:      row.machine_ready_to_run      ?? null,
    machineActuallyRunning: row.machine_actually_running  ?? null,
    machineFaulted:         row.machine_faulted           ?? null,
    machineStopping:        row.machine_stopping          ?? null,
    machineDisabled:        row.machine_disabled          ?? null,
    remoteStartAllowed:     row.remote_start_allowed      ?? null,

    // ── NEW: Diagnostics (written by PLC) ────────────────────────────────────
    axisErrorId:    row.axis_error_id  ?? null,
    diagnosticWord: row.diagnostic_word ?? null,

    // ── NEW: Production counters (NUMERIC → number) ──────────────────────────
    pouchCounter:   row.pouch_counter   !== null ? Number(row.pouch_counter)   : null,
    sessionPouches: row.session_pouches !== null ? Number(row.session_pouches) : null,
    totalPouches:   row.total_pouches   !== null ? Number(row.total_pouches)   : null,

    // ── NEW: Runtime counters (BIGINT string → number) ───────────────────────
    sessionRuntimeSeconds: row.session_runtime_seconds !== null ? Number(row.session_runtime_seconds) : null,
    totalRuntimeSeconds:   row.total_runtime_seconds   !== null ? Number(row.total_runtime_seconds)   : null,

    // ── NEW: Derived rate ────────────────────────────────────────────────────
    productionRatePpm: row.production_rate_ppm !== null ? Number(row.production_rate_ppm) : null,
  };
};
```

- [ ] **Step 4: Run tests — confirm they PASS**

```bash
npx jest tests/services/machineService.test.js --no-coverage
```

Expected: `Tests: 3 passed, 3 total`

- [ ] **Step 5: Commit**

```bash
git add services/machineService.js tests/services/machineService.test.js
git commit -m "feat(api): map 16 new machine_state columns to camelCase in getMachineState"
```

---

## Task 5: pgListenerService.js — Session Tracking

**Files:**
- Modify: `services/pgListenerService.js` (full rewrite — adds session logic, 10 s tick, startup recovery)

This is the most significant backend change. Replace the entire file with the version below. Key additions over the existing file:
- `pool` import from `../config/db`
- `sessionMath` import
- `activeSessions` Map (module-level)
- `sessionTick` interval reference (module-level)
- `handleRunningTransition()` — async, writes to DB
- `handleStopTransition()` — async, accumulates totals
- `tickAllSessions()` — async, called by 10 s interval
- `recoverSessions()` — async, re-hydrates `activeSessions` on startup
- `startPgListener` calls `recoverSessions()` and starts tick before LISTEN
- `stopPgListener` clears tick interval
- Notification handler extended with boolean flag broadcast + transition detection

- [ ] **Step 1: Overwrite `services/pgListenerService.js`**

```js
// services/pgListenerService.js
const { Client } = require('pg');
const { pool }   = require('../config/db');                    // NEW
const { broadcastToMachine } = require('./websocketService');
const logger                 = require('../utils/logger');
const {
  computeSessionRuntimeSeconds,
  computeSessionPouches,
  computeProductionRatePpm,
} = require('../utils/sessionMath');                           // NEW

let listenerClient = null;
let reconnectTimer = null;
let sessionTick    = null;   // NEW — setInterval reference

// ── In-memory session map ──────────────────────────────────────────────────────
// machineId → { startAt: Date, lastPouchCounter: number }
const activeSessions = new Map();  // NEW

// ── DB client config (unchanged) ──────────────────────────────────────────────
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

    activeSessions.set(machineId, { startAt, lastPouchCounter });

    await pool.query(
      `UPDATE machine_state
       SET session_start_at        = $1,
           session_runtime_seconds = 0,
           session_pouches         = 0,
           production_rate_ppm     = 0
       WHERE machine_id = $2`,
      [startAt.toISOString(), machineId]
    );
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

    const currentCounter  = Number(rows[0].pouch_counter)            || 0;
    const sessionPouches  = computeSessionPouches(currentCounter, session.lastPouchCounter);
    const sessionSeconds  = Number(rows[0].session_runtime_seconds)  || 0;

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

  for (const [machineId, session] of activeSessions.entries()) {
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
      `SELECT machine_id, session_start_at, pouch_counter
       FROM machine_state
       WHERE machine_actually_running = true AND session_start_at IS NOT NULL`
    );

    rows.forEach(r => {
      activeSessions.set(r.machine_id, {
        startAt:          new Date(r.session_start_at),
        lastPouchCounter: Number(r.pouch_counter) || 0,
      });
      logger.info(`Session recovered: machine [${r.machine_id}] from ${r.session_start_at}`);
    });

    if (rows.length > 0) logger.info(`Recovered ${rows.length} active session(s)`);
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
  await recoverSessions();                                     // NEW

  // Start 10 s session tick (only once — guard against multiple calls)
  if (!sessionTick) {                                          // NEW
    sessionTick = setInterval(tickAllSessions, 10_000);
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

      // ── Broadcast to WS clients — now includes PLC state flags ───────────
      broadcastToMachine(machineId, {
        type:   'machine_status',
        status,
        ts,
        source: 'db_trigger',
        // NEW: PLC state flags (null when trigger hasn't been updated yet)
        plcFeedbackFresh:       payload.plcFeedbackFresh       ?? null,
        machineReadyToRun:      payload.machineReadyToRun      ?? null,
        machineActuallyRunning: payload.machineActuallyRunning ?? null,
        machineFaulted:         payload.machineFaulted         ?? null,
        machineStopping:        payload.machineStopping        ?? null,
        machineDisabled:        payload.machineDisabled        ?? null,
        remoteStartAllowed:     payload.remoteStartAllowed     ?? null,
      });

      logger.info(`DB trigger → machine [${machineId}] status: ${status}`);

      // ── Session transition detection ──────────────────────────────────────
      const nowRunning = payload.machineActuallyRunning === true;  // NEW
      const wasRunning = activeSessions.has(machineId);            // NEW

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
  if (sessionTick)    { clearInterval(sessionTick); sessionTick = null; }  // NEW
  if (listenerClient) {
    await listenerClient.end().catch(() => {});
    listenerClient = null;
  }
};

module.exports = { startPgListener, stopPgListener };
```

- [ ] **Step 2: Start the backend and confirm no startup errors**

```bash
node server.js
```

Expected log lines (in order):
```
Listening to PostgreSQL channel: telemetry_channel
PG listener ready — watching machine_status_changed
```

No `recoverSessions failed` or `handleRunningTransition` errors.  
Ctrl+C — should log `PG listener connection ended` cleanly.

- [ ] **Step 3: Commit**

```bash
git add services/pgListenerService.js
git commit -m "feat(service): add session tracking to pgListenerService (tick, transitions, recovery)"
```

---

## Task 6: useWebSocket.js — plcState Extraction

**Files:**
- Modify: `src/hooks/useWebSocket.js` (frontend — `plc-frontend` repo)

The hook currently handles `machine_status` with only `setDbStatus(msg.status)`. Extend it to also extract and expose the 7 new PLC state flags.

- [ ] **Step 1: Open `src/hooks/useWebSocket.js` and make two targeted changes**

**Change A — add `plcState` useState** (after line 28, `const [lastDataAt, ...]`):

```js
const [plcState, setPlcState] = useState({
  feedbackFresh:      null,
  readyToRun:         null,
  actuallyRunning:    null,
  faulted:            null,
  stopping:           null,
  disabled:           null,
  remoteStartAllowed: null,
})
```

**Change B — extend the `machine_status` case** (find `case 'machine_status':` around line 102, replace just that case):

```js
case 'machine_status':
  setDbStatus(msg.status)
  // NEW: extract PLC state flags if present in the WS message
  setPlcState({
    feedbackFresh:      msg.plcFeedbackFresh       ?? null,
    readyToRun:         msg.machineReadyToRun      ?? null,
    actuallyRunning:    msg.machineActuallyRunning  ?? null,
    faulted:            msg.machineFaulted         ?? null,
    stopping:           msg.machineStopping        ?? null,
    disabled:           msg.machineDisabled        ?? null,
    remoteStartAllowed: msg.remoteStartAllowed     ?? null,
  })
  break
```

**Change C — add `plcState` to the return object** (find `return {` at the bottom ~line 137):

```js
return {
  telemetry,
  decoded,
  connected,
  lastAlarm,
  dbStatus,
  lastDataAt,
  servos: decoded?.servos ?? [],
  plcState,   // NEW
}
```

- [ ] **Step 2: Verify the change compiles**

```bash
cd plc-frontend
npm run dev
```

Open the app, navigate to a machine LiveView page. Open DevTools → Network → WS. No console errors.

- [ ] **Step 3: Commit**

```bash
cd plc-frontend
git add src/hooks/useWebSocket.js
git commit -m "feat(ws): expose plcState flags from machine_status WS events"
```

---

## Task 7: LiveView.jsx — pollData State + RuntimeClock + ProductionCard

**Files:**
- Modify: `src/components/LiveView.jsx`

Three targeted changes in `LiveView.jsx`. All are inside the main `LiveView` function component.

- [ ] **Step 1: Add `plcState` to the useWebSocket destructure**

Find line (approx 1658):
```js
const { decoded, connected, servos, dbStatus } = useWebSocket(machineId, siteId, lineId)
```

Replace with:
```js
const { decoded, connected, servos, dbStatus, plcState } = useWebSocket(machineId, siteId, lineId)
```

- [ ] **Step 2: Add `pollData` state variable**

Find where `rawApiStatus` and `lastSeenAt` are declared (approx line 1661):
```js
const [rawApiStatus, setRawApiStatus] = useState(null)
const [lastSeenAt,   setLastSeenAt]   = useState(null)
```

Add one more line immediately after:
```js
const [pollData,     setPollData]     = useState(null)   // NEW — holds full /dashboard/machine/:id response
```

- [ ] **Step 3: Populate `pollData` inside the 3 s poll effect**

Find the `fetchStatus` function inside the existing `useEffect` (approx line 1733). It currently ends with:
```js
setRawApiStatus(data?.status ?? null)
setLastSeenAt(data?.lastSeenAt ?? null)
// Pick up siteId/lineId if not yet known
if (!siteId && data?.siteId) setSiteId(data.siteId)
if (!lineId && data?.lineId) setLineId(data.lineId)
```

Add one line at the end of that block:
```js
setPollData(data ?? null)   // NEW — store full response for counter fields
```

- [ ] **Step 4: Update `runtimeSeconds` derivation**

Find (approx line 1697):
```js
const runtimeSeconds = decoded?.deviceUptimeMs != null
  ? Math.floor(decoded.deviceUptimeMs / 1000)
  : 0
```

Replace with:
```js
// Use persistent session counter from DB poll (replaces ephemeral device_uptime_ms)
const runtimeSeconds = pollData?.sessionRuntimeSeconds ?? 0
```

- [ ] **Step 5: Update `ProductionCard` component (around line 951)**

Replace the entire `ProductionCard` component function (from `const ProductionCard = ...` to its closing `}`) with:

```jsx
const ProductionCard = ({ sessionPouches, totalPouches, pouchCounter, productionRatePpm }) => {
  const hasData = pouchCounter !== null && pouchCounter !== undefined

  const fmtNum = (n) => {
    if (n == null) return '—'
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
    if (n >= 1_000)     return `${(n / 1_000).toFixed(2)}K`
    return String(Math.floor(n))
  }

  return (
    <div className="lv-production-card">
      <div style={{ flex: 1 }}>
        <p style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
          color: 'rgba(190,210,255,0.70)', textTransform: 'uppercase', marginBottom: 6,
        }}>Session Production</p>

        {hasData ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{
                fontSize: 40, fontWeight: 800, color: '#f0f4ff',
                lineHeight: 1, letterSpacing: '-0.02em',
              }}>{fmtNum(sessionPouches)}</span>
              <span style={{ fontSize: 14, color: 'rgba(210,220,255,0.65)', fontWeight: 600 }}>pouches</span>
            </div>
            <p style={{
              marginTop: 8, fontSize: 10, color: 'rgba(160,180,230,0.5)',
              fontFamily: 'var(--font-mono)',
            }}>
              All-time: {fmtNum(totalPouches)} · Rate: {productionRatePpm != null ? `${productionRatePpm} ppm` : '—'}
            </p>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline' }}>
              <span style={{
                fontSize: 40, fontWeight: 800, color: 'rgba(180,200,255,0.25)',
                lineHeight: 1, letterSpacing: '-0.02em',
              }}>—</span>
            </div>
            <p style={{
              marginTop: 8, fontSize: 10, color: 'rgba(160,180,230,0.35)',
              fontFamily: 'var(--font-mono)',
            }}>Awaiting PLC counter</p>
          </>
        )}
      </div>

      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '5px 10px', borderRadius: 8,
        background: hasData ? 'rgba(52,211,153,0.08)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${hasData ? 'rgba(52,211,153,0.28)' : 'rgba(255,255,255,0.08)'}`,
        fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
        color: hasData ? 'rgba(52,211,153,0.85)' : 'rgba(160,180,230,0.35)',
        textTransform: 'uppercase', alignSelf: 'flex-end',
      }}>
        {hasData
          ? <><LiveDot active color="#34d399" size={5} />PLC Live</>
          : <>○ No Signal</>
        }
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Update the `<ProductionCard>` JSX call site**

Find (approx line 1876):
```jsx
<ProductionCard
  cycleCount={decoded?.cycleCount ?? null}
/>
```

Replace with:
```jsx
<ProductionCard
  sessionPouches={pollData?.sessionPouches    ?? null}
  totalPouches={pollData?.totalPouches         ?? null}
  pouchCounter={pollData?.pouchCounter         ?? null}
  productionRatePpm={pollData?.productionRatePpm ?? null}
/>
```

- [ ] **Step 7: Verify in browser**

```bash
npm run dev
```

Navigate to a LiveView page. The Session Overview section should show:
- RuntimeClock displaying `sessionRuntimeSeconds` (starts at 0 if no active session)
- ProductionCard showing session pouches with `All-time: X · Rate: Y ppm` subtitle

- [ ] **Step 8: Commit**

```bash
git add src/components/LiveView.jsx
git commit -m "feat(ui): wire pollData to RuntimeClock + update ProductionCard for session counters"
```

---

## Task 8: LiveView.jsx — PLC State Flags Section

**Files:**
- Modify: `src/components/LiveView.jsx`

Replace the existing 4-card "Status Flags" section with 6 PLC-native cards from `plcState`.

- [ ] **Step 1: Find the Status Flags section**

Search for the string `Status Flags` in `LiveView.jsx`. It will be inside a `<Section title="Status Flags" ...>` block containing 4 `<BoolCard>` components for `operationEnabled`, `faultActive`, `warningActive`, `remoteActive`.

- [ ] **Step 2: Replace the entire Status Flags section**

```jsx
{/* ══ ROW 4 LEFT: PLC State Flags ══ */}
<Section title="PLC State Flags" delay={0.26}>
  <div className="lv-bool-grid">
    <BoolCard
      label="Ready to Run"
      value={plcState?.readyToRun ?? null}
      trueColor="#34d399"
      falseColor="rgba(200,215,255,0.28)"
    />
    <BoolCard
      label="Running"
      value={plcState?.actuallyRunning ?? null}
      trueColor="#34d399"
      falseColor="rgba(200,215,255,0.28)"
    />
    <BoolCard
      label="Faulted"
      value={plcState?.faulted ?? null}
      trueColor="#f87171"
      falseColor="#34d399"
    />
    <BoolCard
      label="Stopping"
      value={plcState?.stopping ?? null}
      trueColor="#fbbf24"
      falseColor="rgba(200,215,255,0.28)"
    />
    <BoolCard
      label="Disabled"
      value={plcState?.disabled ?? null}
      trueColor="#fbbf24"
      falseColor="rgba(200,215,255,0.28)"
    />
    <BoolCard
      label="Remote Start"
      value={plcState?.remoteStartAllowed ?? null}
      trueColor="#60a5fa"
      falseColor="rgba(200,215,255,0.28)"
    />
  </div>
</Section>
```

- [ ] **Step 3: Verify in browser**

The middle-left section should now show 6 cards: Ready to Run, Running, Faulted, Stopping, Disabled, Remote Start. All show `—` (null) until the PLC starts sending these flags via the trigger.

- [ ] **Step 4: Commit**

```bash
git add src/components/LiveView.jsx
git commit -m "feat(ui): replace Status Flags with 6 PLC-native state flag cards"
```

---

## Task 9: LiveView.jsx — DiagCard New Rows + isRunning Dual-Source

**Files:**
- Modify: `src/components/LiveView.jsx`

Two small targeted changes.

- [ ] **Step 1: Add axis error and diagnostic word rows to DiagCard**

Find the `<DiagCard rows={[` call (approx line 2028). It currently ends with `{ label: 'Remote', value: remoteActive ? 'YES' : 'NO' }`. Add two rows before the closing `].filter(...)`:

```jsx
<DiagCard rows={[
  { label: 'Fault',        value: errorText, color: faultActive ? '#f87171' : undefined },
  { label: 'Mode',         value: modeDisplayText !== '—' ? modeDisplayText : null },
  { label: 'Network',      value: networkOk ? 'ONLINE' : 'OFFLINE' },
  { label: 'CAN State',    value: canState },
  { label: 'Op. Enabled',  value: operationEnabled ? 'YES' : 'NO' },
  { label: 'Warning',      value: warningActive    ? 'YES' : 'NO' },
  { label: 'Fault Active', value: faultActive      ? 'YES' : 'NO' },
  { label: 'Remote',       value: remoteActive     ? 'YES' : 'NO' },
  // NEW: PLC diagnostics from poll
  {
    label: 'Axis Error',
    value: (pollData?.axisErrorId === 0 || pollData?.axisErrorId == null)
      ? 'No fault'
      : `0x${pollData.axisErrorId.toString(16).toUpperCase()}`,
    color: pollData?.axisErrorId ? '#f87171' : undefined,
  },
  {
    label: 'Diag Word',
    value: pollData?.diagnosticWord != null
      ? `0x${pollData.diagnosticWord.toString(16).toUpperCase().padStart(4, '0')}`
      : '—',
  },
].filter(r => r.value != null)} />
```

- [ ] **Step 2: Update `isRunning` to dual-source**

Find (approx line 1680):
```js
const isRunning = apiStatus === 'RUNNING'
```

Replace with:
```js
// WS flag responds instantly; falls back to polled apiStatus if WS flag not yet received
const isRunning = plcState?.actuallyRunning ?? (apiStatus === 'RUNNING')
```

- [ ] **Step 3: Verify in browser**

- Diagnostics panel (right column) now shows `Axis Error: No fault` and `Diag Word: 0x0000` (or actual values once PLC sends them)
- Start/Stop buttons react immediately when `machine_actually_running` arrives via WS

- [ ] **Step 4: Commit**

```bash
git add src/components/LiveView.jsx
git commit -m "feat(ui): add axis error + diag word to DiagCard; update isRunning to dual-source WS+poll"
```

---

## Task 10: Run All Backend Tests

- [ ] **Step 1: Run the full backend test suite**

```bash
cd plc-backend
npx jest --no-coverage
```

Expected:
```
Test Suites: 2 passed, 2 total
Tests:       12 passed, 12 total
```

- [ ] **Step 2: Smoke-test the running server**

```bash
node server.js
```

In another terminal:
```bash
curl -s http://localhost:5000/api/dashboard/machine/YOUR_MACHINE_ID \
  -H "Authorization: Bearer YOUR_TOKEN" | node -e "
    const d = require('fs').readFileSync('/dev/stdin','utf8');
    const j = JSON.parse(d).data;
    console.log('sessionRuntimeSeconds:', j.sessionRuntimeSeconds);
    console.log('totalPouches:', j.totalPouches);
    console.log('machineActuallyRunning:', j.machineActuallyRunning);
  "
```

Expected: new fields appear in the JSON response (may be `null` until PLC writes them).

- [ ] **Step 3: Final commit — bump the README or changelog if you maintain one**

```bash
git add .
git commit -m "feat: machine-state v2 complete — session tracking, PLC flags, updated dashboard UI"
```

---

## Checklist — Spec Coverage

| Spec requirement | Task |
|---|---|
| 16 new DB columns + `session_start_at` | Task 1 |
| Idempotent migration script | Task 1 |
| Trigger inspection + payload extension guide | Task 2 |
| `computeSessionRuntimeSeconds` pure fn + tests | Task 3 |
| `computeSessionPouches` pure fn + tests (wrap handling) | Task 3 |
| `computeProductionRatePpm` pure fn + tests | Task 3 |
| `getMachineState` camelCase mapping + tests | Task 4 |
| `pgListenerService` session transitions | Task 5 |
| `pgListenerService` 10 s tick | Task 5 |
| `pgListenerService` startup recovery | Task 5 |
| `pgListenerService` WS broadcast with new flags | Task 5 |
| `pgListenerService` graceful shutdown clears tick | Task 5 |
| `useWebSocket` exposes `plcState` | Task 6 |
| `LiveView` `pollData` state + `runtimeSeconds` source swap | Task 7 |
| `ProductionCard` updated with session/total/ppm | Task 7 |
| Status Flags → 6 PLC-native `BoolCard` components | Task 8 |
| DiagCard `axis_error_id` + `diagnostic_word` rows | Task 9 |
| `isRunning` dual-source (WS flag + polled status) | Task 9 |
