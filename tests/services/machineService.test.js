// tests/services/machineService.test.js
jest.mock('../../config/db', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../config/redis', () => ({ getRedis: () => null }));
jest.mock('../../middleware/errorHandler', () => ({
  createError: (msg, code) => { const e = new Error(msg); e.status = code; return e; },
}));

const { getMachineState } = require('../../services/machineService');
const { pool }            = require('../../config/db');

const BASE_ROW = {
  machine_id: 'M1', site_id: 'S1', line_id: 'L1',
  status: 'RUNNING', ts: '2026-01-01T00:00:00Z', payload: {},
  plc_feedback_fresh: true,  machine_ready_to_run: true,
  machine_actually_running: true, machine_faulted: false,
  machine_stopping: false,   machine_disabled: false,
  remote_start_allowed: true,
  axis_error_id: 0,          diagnostic_word: 65,
  pouch_counter: '1000.00',  session_pouches: '250.00',
  total_pouches: '5000.00',  session_runtime_seconds: '900',
  total_runtime_seconds: '18000', production_rate_ppm: '16.67',
  session_start_at: '2026-01-01T00:15:00Z',
};

describe('getMachineState — v2 field mapping', () => {
  test('maps all 16 new columns to camelCase with correct types', async () => {
    pool.query.mockResolvedValue({ rows: [BASE_ROW] });
    const result = await getMachineState('M1');

    // PLC state flags
    expect(result.plcFeedbackFresh).toBe(true);
    expect(result.machineReadyToRun).toBe(true);
    expect(result.machineActuallyRunning).toBe(true);
    expect(result.machineFaulted).toBe(false);
    expect(result.machineStopping).toBe(false);
    expect(result.machineDisabled).toBe(false);
    expect(result.remoteStartAllowed).toBe(true);

    // Diagnostics
    expect(result.axisErrorId).toBe(0);
    expect(result.diagnosticWord).toBe(65);

    // Production counters — NUMERIC strings become JS numbers
    expect(result.pouchCounter).toBe(1000);
    expect(result.sessionPouches).toBe(250);
    expect(result.totalPouches).toBe(5000);

    // Runtime counters — BIGINT strings become JS numbers
    expect(result.sessionRuntimeSeconds).toBe(900);
    expect(result.totalRuntimeSeconds).toBe(18000);
    expect(result.productionRatePpm).toBeCloseTo(16.67);
  });

  test('returns null for all new fields when columns are null', async () => {
    const nullRow = Object.fromEntries(
      Object.keys(BASE_ROW).map(k => [k, null])
    );
    nullRow.machine_id = 'M1';
    pool.query.mockResolvedValue({ rows: [nullRow] });

    const result = await getMachineState('M1');

    expect(result.plcFeedbackFresh).toBeNull();
    expect(result.pouchCounter).toBeNull();
    expect(result.sessionRuntimeSeconds).toBeNull();
    expect(result.productionRatePpm).toBeNull();
  });

  test('returns null when machine not found', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const result = await getMachineState('MISSING');
    expect(result).toBeNull();
  });
});
