// scripts/migrate_v4.js
// Idempotent — safe to run multiple times (IF NOT EXISTS on every column).
// Adds current_actual back to telemetry (previously dropped) plus ensures
// all base telemetry columns exist for app-developer compatibility.
require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  console.log('Running migration v4 — telemetry column restore…\n');

  await pool.query(`
    ALTER TABLE telemetry
    ADD COLUMN IF NOT EXISTS device_uptime_ms       BIGINT,
    ADD COLUMN IF NOT EXISTS can_node_id            INTEGER,
    ADD COLUMN IF NOT EXISTS can_state              TEXT,
    ADD COLUMN IF NOT EXISTS status_word            INTEGER,
    ADD COLUMN IF NOT EXISTS error_code             INTEGER,
    ADD COLUMN IF NOT EXISTS status_flags           INTEGER,
    ADD COLUMN IF NOT EXISTS current_actual         NUMERIC,
    ADD COLUMN IF NOT EXISTS operation_enabled      BOOLEAN,
    ADD COLUMN IF NOT EXISTS fault_active           BOOLEAN,
    ADD COLUMN IF NOT EXISTS warning_active         BOOLEAN,
    ADD COLUMN IF NOT EXISTS remote_active          BOOLEAN,
    ADD COLUMN IF NOT EXISTS mode_display           INTEGER,
    ADD COLUMN IF NOT EXISTS rpdo_rx_counter        INTEGER,
    ADD COLUMN IF NOT EXISTS telemetry_tx_counter   INTEGER
  `);

  console.log('  ✓  All columns ensured (existing ones skipped, current_actual added)');

  // Confirm final column list
  const { rows } = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'telemetry' AND table_schema = 'public'
    ORDER BY ordinal_position
  `);

  console.log('\nFinal telemetry columns:');
  rows.forEach(r => console.log(`  ${r.column_name.padEnd(30)} ${r.data_type}`));
  console.log('\nMigration v4 complete.');
}

run()
  .catch(e => { console.error('Migration failed:', e.stack || e.message); process.exit(1); })
  .finally(() => pool.end());
