const express = require('express');
const router  = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const machineService         = require('../services/machineService');

// GET /api/machines
router.get('/', protect, async (req, res, next) => {
  try {
    const machines = await machineService.getAllMachines();
    res.json({ success: true, data: machines });
  } catch (err) {
    next(err);
  }
});

// GET /api/machines/:machineId
router.get('/:machineId', protect, async (req, res, next) => {
  try {
    const machine = await machineService.getMachineById(req.params.machineId);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    res.json({ success: true, data: machine });
  } catch (err) {
    next(err);
  }
});

// POST /api/machines — admin only
router.post('/', protect, authorize('admin'), async (req, res, next) => {
  try {
    const { machineId, name, description, mode } = req.body;

    if (!machineId || !name) {
      return res.status(400).json({ error: 'machineId and name are required' });
    }

    const machine = await machineService.registerMachine({
      machineId, name, description, mode: mode || 'MODE 1',
    });

    res.status(201).json({ success: true, data: machine });
  } catch (err) {
    next(err);
  }
});

// PUT /api/machines/:machineId/mode
router.put('/:machineId/mode', protect, async (req, res, next) => {
  try {
    const { mode } = req.body;
    if (!['MODE 1', 'MODE 2'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "MODE 1" or "MODE 2"' });
    }

    const updated = await machineService.updateMode(req.params.machineId, mode);
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;