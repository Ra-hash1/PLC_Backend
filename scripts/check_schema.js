require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  const { rows } = await pool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_name = 'telemetry'
     ORDER BY ordinal_position`
  );
  rows.forEach(r => console.log(r.column_name, '|', r.data_type));
  await pool.end();
}
run().catch(e => { console.error(e.message); process.exit(1); });
