/**
 * Migration: add cycle_count column to telemetry table.
 * cycle_count (BIGINT) — cumulative output cycle counter reported by the
 * ESP32/PLC directly. Replaces the frontend-estimated localStorage counter.
 */
require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  console.log('Checking for cycle_count column…');

  const { rows } = await pool.query(`
    SELECT column_name
    FROM   information_schema.columns
    WHERE  table_name  = 'telemetry'
    AND    column_name = 'cycle_count'
  `);

  if (rows.length > 0) {
    console.log('Column cycle_count already exists — nothing to do.');
    return;
  }

  console.log('Adding cycle_count BIGINT to telemetry…');
  await pool.query(`ALTER TABLE telemetry ADD COLUMN cycle_count BIGINT`);
  console.log('Done. Column added.');
}

run()
  .catch(e => { console.error('Migration failed:', e.message); process.exit(1); })
  .finally(() => pool.end());
