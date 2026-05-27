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
    WHERE table_name = 'machine_state' AND table_schema = 'public'
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
  .catch(e => { console.error('Migration failed:', e.stack || e.message); process.exit(1); })
  .finally(() => pool.end());
