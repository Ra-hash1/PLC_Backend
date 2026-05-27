// scripts/install_machine_state_triggers.js
// Installs / replaces two triggers on machine_state:
//
//  1. machine_state_sync_trigger  (BEFORE INSERT OR UPDATE)
//     Extracts PLC flags + diagnostics + pouch_counter from NEW.payload
//     into the dedicated columns automatically on every write.
//     Does NOT touch session tracking columns managed by pgListenerService.
//
//  2. notify_machine_status_change  (AFTER UPDATE — existing, replaced)
//     Updated to include all PLC flag columns in the NOTIFY payload so
//     pgListenerService receives machineActuallyRunning etc. directly.
//     Now fires when status OR machine_actually_running changes.
//
// Safe to re-run — all statements use CREATE OR REPLACE / DROP IF EXISTS.
require('dotenv').config();
const { pool } = require('../config/db');

async function run() {

  // ── 1. BEFORE trigger: sync payload → columns ────────────────────────────────
  console.log('1. Installing sync trigger (payload → columns)…');

  await pool.query(`
    CREATE OR REPLACE FUNCTION sync_machine_state_from_payload()
    RETURNS TRIGGER AS $$
    DECLARE
      v_primary_servo JSONB;
      v_servos        JSONB;
    BEGIN
      IF NEW.payload IS NULL THEN
        RETURN NEW;
      END IF;

      -- ── PLC state flags ───────────────────────────────────────────────────
      NEW.plc_feedback_fresh       := (NEW.payload->>'plcFeedbackFresh')::boolean;
      NEW.machine_ready_to_run     := (NEW.payload->>'machineReadyToRun')::boolean;
      NEW.machine_actually_running := (NEW.payload->>'machineActuallyRunning')::boolean;
      NEW.machine_faulted          := (NEW.payload->>'machineFaulted')::boolean;
      NEW.machine_stopping         := (NEW.payload->>'machineStopping')::boolean;
      NEW.machine_disabled         := (NEW.payload->>'machineDisabled')::boolean;
      NEW.remote_start_allowed     := (NEW.payload->>'remoteStartAllowed')::boolean;

      -- ── Pouch counter (pgListenerService reads this, never writes it) ─────
      IF NEW.payload->>'pouchCounter' IS NOT NULL THEN
        NEW.pouch_counter := (NEW.payload->>'pouchCounter')::numeric;
      END IF;

      -- ── Primary servo: first faulted servo, else first servo ─────────────
      v_servos := NEW.payload->'servos';

      IF jsonb_typeof(v_servos) = 'array' AND jsonb_array_length(v_servos) > 0 THEN
        -- Try to find a servo with a non-zero axisErrorId or faulted = true
        SELECT s INTO v_primary_servo
        FROM jsonb_array_elements(v_servos) AS s
        WHERE ((s->>'axisErrorId')::int IS NOT NULL AND (s->>'axisErrorId')::int <> 0)
           OR (s->>'faulted')::boolean = true
        LIMIT 1;

        -- Fall back to first servo
        IF v_primary_servo IS NULL THEN
          v_primary_servo := v_servos->0;
        END IF;

        NEW.axis_error_id   := (v_primary_servo->>'axisErrorId')::integer;
        NEW.diagnostic_word := (v_primary_servo->>'diagnosticWord')::integer;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  console.log('  ✓  sync_machine_state_from_payload() function created/replaced');

  await pool.query(`DROP TRIGGER IF EXISTS machine_state_sync_trigger ON machine_state`);
  await pool.query(`
    CREATE TRIGGER machine_state_sync_trigger
    BEFORE INSERT OR UPDATE ON machine_state
    FOR EACH ROW EXECUTE FUNCTION sync_machine_state_from_payload();
  `);
  console.log('  ✓  machine_state_sync_trigger (BEFORE INSERT OR UPDATE) installed');

  // ── 2. AFTER trigger: update NOTIFY to include PLC flags ─────────────────────
  console.log('\n2. Updating notify_machine_status_change() to include PLC flags…');

  await pool.query(`
    CREATE OR REPLACE FUNCTION notify_machine_status_change()
    RETURNS TRIGGER AS $$
    BEGIN
      -- Fire when status OR machine_actually_running changes
      IF (OLD.status IS DISTINCT FROM NEW.status)
      OR (OLD.machine_actually_running IS DISTINCT FROM NEW.machine_actually_running)
      THEN
        PERFORM pg_notify(
          'machine_status_changed',
          json_build_object(
            'machineId',              NEW.machine_id,
            'status',                 NEW.status,
            'ts',                     NEW.ts,
            'plcFeedbackFresh',       NEW.plc_feedback_fresh,
            'machineReadyToRun',      NEW.machine_ready_to_run,
            'machineActuallyRunning', NEW.machine_actually_running,
            'machineFaulted',         NEW.machine_faulted,
            'machineStopping',        NEW.machine_stopping,
            'machineDisabled',        NEW.machine_disabled,
            'remoteStartAllowed',     NEW.remote_start_allowed
          )::text
        );
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  console.log('  ✓  notify_machine_status_change() updated with PLC flags');

  // ── 3. Backfill: sync existing rows from their current payload ────────────────
  console.log('\n3. Backfilling existing rows from payload…');
  const { rowCount } = await pool.query(`
    UPDATE machine_state
    SET payload = payload   -- no-op value change; triggers the BEFORE trigger
    WHERE payload IS NOT NULL
  `);
  console.log(`  ✓  ${rowCount} row(s) backfilled`);

  // ── 4. Verify ─────────────────────────────────────────────────────────────────
  console.log('\n4. Verifying machine_state columns after backfill…');
  const { rows } = await pool.query(`
    SELECT machine_id,
           machine_actually_running,
           machine_faulted,
           machine_stopping,
           remote_start_allowed,
           plc_feedback_fresh,
           axis_error_id,
           diagnostic_word,
           pouch_counter
    FROM machine_state
  `);
  rows.forEach(r => {
    console.log(`\n  machine: ${r.machine_id}`);
    Object.entries(r).forEach(([k, v]) => {
      if (k !== 'machine_id') console.log(`    ${k.padEnd(26)} = ${v}`);
    });
  });

  console.log('\nAll done.\n');
}

run()
  .catch(e => { console.error('Failed:', e.stack || e.message); process.exit(1); })
  .finally(() => pool.end());
