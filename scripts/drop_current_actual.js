/**
 * Migration: drop current_actual column from telemetry table.
 * current_actual (drive phase current in amps) is no longer collected or
 * displayed — removed from frontend, backend service, and schema.
 */
require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  console.log('Checking for current_actual column…');

  const { rows } = await pool.query(`
    SELECT column_name
    FROM   information_schema.columns
    WHERE  table_name  = 'telemetry'
    AND    column_name = 'current_actual'
  `);

  if (rows.length === 0) {
    console.log('Column current_actual does not exist — nothing to do.');
    return;
  }

  console.log('Dropping column current_actual from telemetry…');
  await pool.query(`ALTER TABLE telemetry DROP COLUMN current_actual`);
  console.log('Done. Column removed.');
}

run()
  .catch(e => { console.error('Migration failed:', e.message); process.exit(1); })
  .finally(() => pool.end());
