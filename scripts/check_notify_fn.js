require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  // Get the notify function definition
  const { rows: fn } = await pool.query(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p WHERE p.proname = 'notify_telemetry_insert'`
  );
  if (fn.length) {
    console.log('\n=== FUNCTION BODY ===');
    console.log(fn[0].def);
  } else {
    console.log('Function notify_telemetry_insert not found');
  }

  // Latest telemetry row
  const { rows: latest } = await pool.query('SELECT * FROM telemetry ORDER BY ts DESC LIMIT 1');
  if (latest.length === 0) {
    console.log('\n(no rows in telemetry table)');
  } else {
    console.log('\n=== LATEST TELEMETRY ROW ===');
    const row = latest[0];
    Object.entries(row).forEach(([k, v]) => {
      const display = v === null ? 'NULL'
        : typeof v === 'object' ? JSON.stringify(v).slice(0, 300)
        : String(v).slice(0, 300);
      console.log(`  ${k.padEnd(24)} = ${display}`);
    });
  }

  await pool.end();
}
run().catch(e => { console.error(e.message); process.exit(1); });
