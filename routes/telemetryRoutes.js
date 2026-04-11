const express = require('express');
const router  = express.Router();
const { protect }      = require('../middleware/authMiddleware');
const telemetryService = require('../services/telemetryService');

// GET /api/telemetry/:machineId/latest
// Returns latest telemetry snapshot for a machine (Redis → DB fallback)
router.get('/:machineId/latest', protect, async (req, res, next) => {
  try {
    const snapshot = await telemetryService.getLatestTelemetry(req.params.machineId);

    if (!snapshot) {
      return res.status(404).json({ error: 'No telemetry found for this machine' });
    }

    res.json({ success: true, data: snapshot });
  } catch (err) {
    next(err);
  }
});

// GET /api/telemetry/:machineId/history
// Returns time-series telemetry from PostgreSQL
router.get('/:machineId/history', protect, async (req, res, next) => {
  try {
    const { from, to, limit } = req.query;

    const history = await telemetryService.getTelemetryHistory({
      machineId: req.params.machineId,
      from:      from  || null,
      to:        to    || null,
      limit:     parseInt(limit) || 100,
    });

    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
});

module.exports = router;