// scripts/migrate_v3.js
// Idempotent — safe to run multiple times.
// Covers:
//  1. Add PLC-state + production columns to telemetry
//  2. Create machine_production_state table
//  3. Create machine_production_events table + index
//  4. Add analytics indexes on telemetry + machine_state
require('dotenv').config();
const { pool } = require('../config/db');

// ── 1. New columns for the telemetry table ─────────────────────────────────────
const TELEMETRY_COLUMNS = [
  { name: 'plc_feedback_fresh',        def: 'BOOLEAN' },
  { name: 'machine_ready_to_run',      def: 'BOOLEAN' },
  { name: 'machine_actually_running',  def: 'BOOLEAN' },
  { name: 'machine_faulted',           def: 'BOOLEAN' },
  { name: 'machine_stopping',          def: 'BOOLEAN' },
  { name: 'machine_disabled',          def: 'BOOLEAN' },
  { name: 'remote_start_allowed',      def: 'BOOLEAN' },
  { name: 'axis_error_id',             def: 'INTEGER' },
  { name: 'diagnostic_word',           def: 'INTEGER' },
  { name: 'total_runtime_seconds',     def: 'BIGINT' },
  { name: 'session_runtime_seconds',   def: 'BIGINT' },
  { name: 'total_pouches',             def: 'NUMERIC(14,2)' },
  { name: 'session_pouches',           def: 'NUMERIC(14,2)' },
  { name: 'pouch_counter',             def: 'NUMERIC(14,2)' },
  { name: 'production_rate_ppm',       def: 'NUMERIC(10,2)' },
];

// ── 2. machine_production_state DDL ───────────────────────────────────────────
const CREATE_PRODUCTION_STATE = `
CREATE TABLE IF NOT EXISTS machine_production_state (
  machine_id              VARCHAR(100) PRIMARY KEY,
  site_id                 VARCHAR(100),
  line_id                 VARCHAR(100),
  total_runtime_seconds   BIGINT       NOT NULL DEFAULT 0,
  session_runtime_seconds BIGINT       NOT NULL DEFAULT 0,
  total_pouches           NUMERIC(14,2) NOT NULL DEFAULT 0,
  session_pouches         NUMERIC(14,2) NOT NULL DEFAULT 0,
  pouch_counter           NUMERIC(14,2) NOT NULL DEFAULT 0,
  production_rate_ppm     NUMERIC(10,2) NOT NULL DEFAULT 0,
  session_started_at      TIMESTAMPTZ,
  last_running_at         TIMESTAMPTZ,
  last_update_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  payload                 JSONB        NOT NULL DEFAULT '{}'::jsonb
);`;

// ── 3. machine_production_events DDL ──────────────────────────────────────────
const CREATE_PRODUCTION_EVENTS = `
CREATE TABLE IF NOT EXISTS machine_production_events (
  id                      SERIAL       PRIMARY KEY,
  machine_id              VARCHAR(100) NOT NULL,
  site_id                 VARCHAR(100),
  line_id                 VARCHAR(100),
  event_type              VARCHAR(50)  NOT NULL,
  event_ts                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  total_runtime_seconds   BIGINT,
  session_runtime_seconds BIGINT,
  total_pouches           NUMERIC(14,2),
  session_pouches         NUMERIC(14,2),
  production_rate_ppm     NUMERIC(10,2),
  payload                 JSONB        NOT NULL DEFAULT '{}'::jsonb
);`;

const CREATE_EVENTS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_machine_production_events_machine_ts
ON machine_production_events(machine_id, event_ts DESC);`;

// ── 4. Indexes ─────────────────────────────────────────────────────────────────
const INDEXES = [
  {
    name: 'idx_telemetry_machine_ts_desc',
    ddl:  `CREATE INDEX IF NOT EXISTS idx_telemetry_machine_ts_desc
           ON telemetry(machine_id, ts DESC)`,
  },
  {
    name: 'idx_telemetry_machine_running',
    ddl:  `CREATE INDEX IF NOT EXISTS idx_telemetry_machine_running
           ON telemetry(machine_id, machine_actually_running)`,
  },
  {
    name: 'idx_telemetry_machine_faulted',
    ddl:  `CREATE INDEX IF NOT EXISTS idx_telemetry_machine_faulted
           ON telemetry(machine_id, machine_faulted)`,
  },
  {
    name: 'idx_telemetry_remote_start_allowed',
    ddl:  `CREATE INDEX IF NOT EXISTS idx_telemetry_remote_start_allowed
           ON telemetry(machine_id, remote_start_allowed)`,
  },
  {
    name: 'idx_machine_state_remote_start_allowed',
    ddl:  `CREATE INDEX IF NOT EXISTS idx_machine_state_remote_start_allowed
           ON machine_state(machine_id, remote_start_allowed)`,
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────────
async function run() {
  // 1. telemetry columns
  console.log('1. Checking telemetry columns…\n');
  const { rows: existing } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'telemetry' AND table_schema = 'public'
  `);
  const existingSet = new Set(existing.map(r => r.column_name));

  for (const col of TELEMETRY_COLUMNS) {
    if (existingSet.has(col.name)) {
      console.log(`  ✓  ${col.name.padEnd(30)} already exists`);
    } else {
      await pool.query(`ALTER TABLE telemetry ADD COLUMN ${col.name} ${col.def}`);
      console.log(`  ✚  ${col.name.padEnd(30)} added`);
    }
  }

  // 2. machine_production_state
  console.log('\n2. Creating machine_production_state…');
  await pool.query(CREATE_PRODUCTION_STATE);
  console.log('  ✓  machine_production_state — OK');

  // 3. machine_production_events
  console.log('\n3. Creating machine_production_events…');
  await pool.query(CREATE_PRODUCTION_EVENTS);
  await pool.query(CREATE_EVENTS_INDEX);
  console.log('  ✓  machine_production_events — OK');
  console.log('  ✓  idx_machine_production_events_machine_ts — OK');

  // 4. Indexes
  console.log('\n4. Creating indexes…');
  for (const idx of INDEXES) {
    await pool.query(idx.ddl);
    console.log(`  ✓  ${idx.name}`);
  }

  console.log('\nMigration v3 complete.\n');
}

run()
  .catch(e => { console.error('Migration failed:', e.stack || e.message); process.exit(1); })
  .finally(() => pool.end());
