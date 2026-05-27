// scripts/update_machine_state_trigger.js
require('dotenv').config();
const { pool } = require('../config/db');

async function run() {
  console.log('=== Searching for machine_status_changed trigger function ===\n');

  const { rows } = await pool.query(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    WHERE pg_get_functiondef(p.oid) ILIKE '%machine_status_changed%'
  `);

  if (rows.length === 0) {
    console.log('No trigger function referencing machine_status_changed found.');
    console.log('Check DB manually: SELECT * FROM pg_trigger WHERE tgname ILIKE \'%machine%\';');
  } else {
    rows.forEach(r => {
      console.log(`Function: ${r.proname}\n`);
      console.log(r.def);
    });
  }

  console.log('\n=== REQUIRED CHANGE TO THE NOTIFY PAYLOAD ===');
  console.log('Find the json_build_object(...) call in your trigger function.');
  console.log('Add these key-value pairs to it:\n');
  console.log(`
  'plcFeedbackFresh',       NEW.plc_feedback_fresh,
  'machineReadyToRun',      NEW.machine_ready_to_run,
  'machineActuallyRunning', NEW.machine_actually_running,
  'machineFaulted',         NEW.machine_faulted,
  'machineStopping',        NEW.machine_stopping,
  'machineDisabled',        NEW.machine_disabled,
  'remoteStartAllowed',     NEW.remote_start_allowed
  `);
  console.log('Apply the updated CREATE OR REPLACE FUNCTION ... in your DB client (psql / pgAdmin).');
}

run()
  .catch(e => { console.error(e.message); process.exit(1); })
  .finally(() => pool.end());
