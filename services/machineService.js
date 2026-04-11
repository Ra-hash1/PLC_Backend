const { pool }        = require('../config/db');
const { getRedis }    = require('../config/redis');
const { createError } = require('../middleware/errorHandler');

// ─── Get all machines ─────────────────────────────────
const getAllMachines = async () => {
  const { rows } = await pool.query(
    `SELECT * FROM machines ORDER BY created_at DESC`
  );

  const redis = getRedis();
  const enriched = await Promise.all(
    rows.map(async (machine) => {
      let telemetry = null;
      if (redis) {
        try {
          const raw = await redis.get(`telemetry:latest:${machine.machine_id}`);
          telemetry = raw ? JSON.parse(raw) : null;
        } catch (e) {}
      }
      return {
        ...machine,
        currentStatus: telemetry?.status || 'UNKNOWN',
        lastSeen:      telemetry?.timestamp || null,
      };
    })
  );

  return enriched;
};

// ─── Get single machine by machineId ──────────────────
const getMachineById = async (machineId) => {
  const { rows } = await pool.query(
    `SELECT * FROM machines WHERE machine_id = $1`,
    [machineId]
  );

  if (rows.length === 0) return null;

  const machine = rows[0];

  let telemetry = null;
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(`telemetry:latest:${machineId}`);
      telemetry = raw ? JSON.parse(raw) : null;
    } catch (e) {}
  }

  return {
    ...machine,
    currentStatus: telemetry?.status || 'UNKNOWN',
    lastSeen:      telemetry?.timestamp || null,
    latestData:    telemetry?.data || {},
  };
};

// ─── Register a new machine ───────────────────────────
const registerMachine = async ({ machineId, name, description, mode }) => {
  const existing = await pool.query(
    `SELECT id FROM machines WHERE machine_id = $1`,
    [machineId]
  );

  if (existing.rows.length > 0) {
    throw createError(`Machine '${machineId}' already registered`, 409);
  }

  const { rows } = await pool.query(
    `INSERT INTO machines (machine_id, name, description, mode, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [machineId, name, description || null, mode]
  );

  return rows[0];
};

// ─── Update operating mode ────────────────────────────
const updateMode = async (machineId, mode) => {
  const { rows } = await pool.query(
    `UPDATE machines SET mode = $1, updated_at = NOW()
     WHERE machine_id = $2
     RETURNING *`,
    [mode, machineId]
  );

  if (rows.length === 0) throw createError('Machine not found', 404);

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(`machine:mode:${machineId}`, mode);
    } catch (e) {}
  }

  return rows[0];
};

// ─── DASHBOARD / MACHINE STATE ───────────────────────────────────────────────

const getAllSites = async () => {
  const query = `
    SELECT DISTINCT site_id 
    FROM machine_state 
    WHERE site_id IS NOT NULL
    ORDER BY site_id
  `;
  const { rows } = await pool.query(query);
  return rows.map(r => r.site_id);
};

const getMachinesBySite = async (siteId) => {
  const query = `
    SELECT DISTINCT machine_id, line_id, status
    FROM machine_state
    WHERE site_id = $1
    ORDER BY line_id, machine_id
  `;
  const { rows } = await pool.query(query, [siteId]);
  return rows;
};

const getMachineState = async (machineId) => {
  const query = `
    SELECT *
    FROM machine_state
    WHERE machine_id = $1
  `;
  const { rows } = await pool.query(query, [machineId]);
  return rows[0];
};

const getDashboardBySite = async (siteId) => {
  const query = `
    SELECT 
      site_id,
      line_id,
      machine_id,
      status,
      ts AS last_updated,
      payload
    FROM machine_state
    WHERE site_id = $1
    ORDER BY line_id, machine_id
  `;
  const { rows } = await pool.query(query, [siteId]);
  return rows;
};

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  getAllMachines,
  getMachineById,
  registerMachine,
  updateMode,
  getAllSites,
  getMachinesBySite,
  getMachineState,
  getDashboardBySite
};