require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  // 1. Telemetry table columns
  console.log('\n=== TELEMETRY TABLE COLUMNS ===');
  const { rows: cols } = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM   information_schema.columns
    WHERE  table_name = 'telemetry'
    ORDER BY ordinal_position
  `);
  cols.forEach(c => console.log(`  ${c.column_name.padEnd(24)} ${c.data_type.padEnd(30)} nullable=${c.is_nullable}`));

  // 2. Triggers on telemetry table
  console.log('\n=== TRIGGERS ON TELEMETRY ===');
  const { rows: trigs } = await pool.query(`
    SELECT trigger_name, event_manipulation, action_timing, action_statement
    FROM   information_schema.triggers
    WHERE  event_object_table = 'telemetry'
  `);
  if (trigs.length === 0) console.log('  (none)');
  trigs.forEach(t => console.log(`  ${t.trigger_name} | ${t.event_manipulation} | ${t.action_timing}\n  ${t.action_statement}`));

  // 3. Functions / procedures that NOTIFY telemetry_channel
  console.log('\n=== FUNCTIONS WITH NOTIFY telemetry_channel ===');
  const { rows: fns } = await pool.query(`
    SELECT routine_name, routine_type
    FROM   information_schema.routines
    WHERE  routine_definition ILIKE '%telemetry_channel%'
    OR     routine_definition ILIKE '%telemetry%'
    LIMIT 20
  `);
  if (fns.length === 0) console.log('  (none found via information_schema)');
  fns.forEach(f => console.log(`  ${f.routine_name} [${f.routine_type}]`));

  // 4. pg_proc fallback — look for any function body referencing telemetry_channel
  console.log('\n=== pg_proc: NOTIFY telemetry_channel ===');
  const { rows: pgfns } = await pool.query(`
    SELECT p.proname, l.lanname
    FROM   pg_proc p
    JOIN   pg_language l ON l.oid = p.prolang
    WHERE  pg_get_functiondef(p.oid) ILIKE '%telemetry_channel%'
  `);
  if (pgfns.length === 0) console.log('  (none)');
  pgfns.forEach(f => console.log(`  ${f.proname} [${f.lanname}]`));

  // 5. Latest telemetry row — see what's actually stored
  console.log('\n=== LATEST TELEMETRY ROW ===');
  const { rows: latest } = await pool.query(`
    SELECT * FROM telemetry ORDER BY ts DESC LIMIT 1
  `);
  if (latest.length === 0) { console.log('  (no rows)'); }
  else {
    const row = latest[0];
    Object.entries(row).forEach(([k, v]) => {
      const display = v === null ? 'NULL' :
                      typeof v === 'object' ? JSON.stringify(v).slice(0, 120) :
                      String(v).slice(0, 120);
      console.log(`  ${k.padEnd(24)} = ${display}`);
    });
  }

  await pool.end();
}

run().catch(e => { console.error(e.message); process.exit(1); });
