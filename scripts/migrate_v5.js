// scripts/migrate_v5.js
// Idempotent — safe to run multiple times (ADD COLUMN IF NOT EXISTS on every change).
// Adds:
//   1. canopen_nodes JSONB  — per-node CANopen network topology snapshot from ESP32
//   2. raw_payload   JSONB  — full Lambda payload preserved for debugging / future fields
require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  console.log('Running migration v5 — canopen_nodes + raw_payload…\n');

  await pool.query(`
    ALTER TABLE telemetry
      ADD COLUMN IF NOT EXISTS canopen_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS raw_payload   JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
  console.log('  ✓  canopen_nodes  (JSONB, default [])');
  console.log('  ✓  raw_payload    (JSONB, default {})');

  // GIN index — makes queries like "find rows where any node has errorCode ≠ 0" fast
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_telemetry_canopen_nodes_gin
      ON telemetry USING gin (canopen_nodes);
  `);
  console.log('  ✓  GIN index idx_telemetry_canopen_nodes_gin');

  // Confirm columns exist
  const { rows } = await pool.query(`
    SELECT column_name, data_type
    FROM   information_schema.columns
    WHERE  table_name = 'telemetry' AND table_schema = 'public'
      AND  column_name IN ('canopen_nodes', 'raw_payload')
    ORDER BY column_name
  `);
  console.log('\nVerification:');
  rows.forEach(r => console.log(`  ${r.column_name.padEnd(16)} ${r.data_type}`));

  console.log('\nMigration v5 complete.\n');
}

run()
  .catch(e => { console.error('Migration failed:', e.stack || e.message); process.exit(1); })
  .finally(() => pool.end());
