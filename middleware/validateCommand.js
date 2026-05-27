// ─── Valid commands (aligned with mobile app) ─────────
const VALID_COMMANDS    = ['start', 'stop', 'reset', 'setSpeed'];
const VALID_BATCH_CUTTER = ['ON', 'OFF'];

const validateCommand = (req, res, next) => {
  const { siteId, lineId, machineId, command, params } = req.body;

  // ── Required identifiers ──────────────────────────────
  if (!siteId || !lineId || !machineId) {
    return res.status(400).json({
      error: 'Missing required fields: siteId, lineId, machineId',
    });
  }

  // ── Valid command name ────────────────────────────────
  if (!command || !VALID_COMMANDS.includes(command)) {
    return res.status(400).json({
      error: `Invalid command. Must be one of: ${VALID_COMMANDS.join(', ')}`,
    });
  }

  // ── Per-command param validation ──────────────────────

  // start — optional: params.speed (positive number), params.batchCutter ('ON'|'OFF')
  if (command === 'start') {
    if (params?.speed !== undefined) {
      if (typeof params.speed !== 'number' || params.speed < 0) {
        return res.status(400).json({
          error: 'start: params.speed must be a positive number',
        });
      }
    }
    if (params?.batchCutter !== undefined) {
      if (!VALID_BATCH_CUTTER.includes(params.batchCutter)) {
        return res.status(400).json({
          error: `start: params.batchCutter must be 'ON' or 'OFF'`,
        });
      }
    }
  }

  // setSpeed — optional: params.speed (positive number if provided)
  //            optional: params.batchCutter ('ON'|'OFF')
  //            At least one param must be present.
  if (command === 'setSpeed') {
    if (params?.speed !== undefined) {
      if (typeof params.speed !== 'number' || params.speed < 0) {
        return res.status(400).json({
          error: 'setSpeed: params.speed must be a positive number',
        });
      }
    }
    if (params?.batchCutter !== undefined) {
      if (!VALID_BATCH_CUTTER.includes(params.batchCutter)) {
        return res.status(400).json({
          error: `setSpeed: params.batchCutter must be 'ON' or 'OFF'`,
        });
      }
    }
    if (params?.speed === undefined && params?.batchCutter === undefined) {
      return res.status(400).json({
        error: 'setSpeed requires at least params.speed or params.batchCutter',
      });
    }
  }

  next();
};

module.exports = { validateCommand };
