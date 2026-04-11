const express = require('express');
const router  = express.Router();
const { protect }  = require('../middleware/authMiddleware');
const alarmService = require('../services/alarmService');

// GET /api/alarms/:machineId
// Active and recent alarms for a machine
router.get('/:machineId', protect, async (req, res, next) => {
  try {
    const { machineId } = req.params;
    const alarms = await alarmService.getAlarms(machineId);
    res.json({ success: true, data: alarms });
  } catch (err) {
    next(err);
  }
});

// POST /api/alarms
// Ingest an alarm event (called by ESP32 / AWS IoT Rule)
router.post('/', async (req, res, next) => {
  try {
    const { siteId, lineId, machineId, alarmCode, message, severity } = req.body;

    if (!machineId || !alarmCode) {
      return res.status(400).json({ error: 'machineId and alarmCode are required' });
    }

    const alarm = await alarmService.createAlarm({
      siteId, lineId, machineId, alarmCode, message, severity: severity || 'WARNING',
    });

    res.status(201).json({ success: true, data: alarm });
  } catch (err) {
    next(err);
  }
});

// PUT /api/alarms/:alarmId/acknowledge
// Acknowledge an alarm
router.put('/:alarmId/acknowledge', protect, async (req, res, next) => {
  try {
    const updated = await alarmService.acknowledgeAlarm(
      req.params.alarmId,
      req.user.id
    );
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
