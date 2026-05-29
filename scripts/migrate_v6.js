// scripts/migrate_v6.js
// Fixes `payload string too long` crash on the telemetry NOTIFY trigger.
//
// Root cause:
//   notify_telemetry_insert() used row_to_json(NEW)::text which serialises every
//   column. PostgreSQL NOTIFY limit is 8 000 bytes. raw_payload (full Lambda
//   event JSON) alone can be 10-20 KB, and servos[] + canopen_nodes[] each add
//   several more KB — all three easily blow the limit.
//
// Fix:
//   Trigger sends ONLY the row id + lightweight scalar fields (< 500 bytes).
//   The Node.js telemetryService NOTIFY handler then does one PK SELECT to fetch
//   the full row (including servos, canopen_nodes) before broadcasting.
//   This permanently lifts the size constraint regardless of array sizes.
//
// Safe to re-run — CREATE OR REPLACE.
require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  console.log('Migration v6 — fix notify_telemetry_insert() payload size…\n');

  await pool.query(`
    CREATE OR REPLACE FUNCTION notify_telemetry_insert()
    RETURNS TRIGGER AS $$
    BEGIN
      -- Send only the row id + the lightest scalar fields (<500 bytes guaranteed).
      -- The Node.js listener re-fetches the full row by PK on every notification,
      -- so JSONB arrays (servos, canopen_nodes, raw_payload) stay out of the
      -- 8 000-byte NOTIFY payload limit entirely.
      PERFORM pg_notify(
        'telemetry_channel',
        json_build_object(
          'id',         NEW.id,
          'machine_id', NEW.machine_id,
          'site_id',    NEW.site_id,
          'line_id',    NEW.line_id,
          'ts',         NEW.ts
        )::text
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  console.log('  ✓  notify_telemetry_insert() replaced (raw_payload excluded)');

  // Verify the new function body is in place
  const { rows } = await pool.query(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM   pg_proc p
    WHERE  p.proname = 'notify_telemetry_insert'
  `);

  if (rows.length === 0) {
    throw new Error('notify_telemetry_insert not found after replacement');
  }

  // Verify: must have json_build_object, must NOT have row_to_json or JSONB array keys
  const def              = rows[0].def;
  const hasJsonBuild     = def.includes('json_build_object');
  const hasRowToJson     = def.includes('row_to_json');
  const hasServosKey     = /'servos'/.test(def);
  const hasCanopenKey    = /'canopen_nodes'/.test(def);
  const hasRawPayloadKey = /'raw_payload'/.test(def);

  console.log(`  ${hasJsonBuild      ? '✓' : '✗'}  uses json_build_object`);
  console.log(`  ${!hasRowToJson     ? '✓' : '✗'}  row_to_json removed`);
  console.log(`  ${!hasServosKey     ? '✓' : '✗'}  servos excluded from NOTIFY`);
  console.log(`  ${!hasCanopenKey    ? '✓' : '✗'}  canopen_nodes excluded from NOTIFY`);
  console.log(`  ${!hasRawPayloadKey ? '✓' : '✗'}  raw_payload excluded from NOTIFY`);

  if (!hasJsonBuild || hasRowToJson || hasServosKey || hasCanopenKey || hasRawPayloadKey) {
    throw new Error('Function replacement verification failed — check DB manually');
  }

  console.log('\nMigration v6 complete.\n');
}

run()
  .catch(e => { console.error('Migration failed:', e.stack || e.message); process.exit(1); })
  .finally(() => pool.end());
