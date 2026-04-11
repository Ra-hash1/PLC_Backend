const express  = require('express');
const router   = express.Router();
const { protect }          = require('../middleware/authMiddleware');
const { validateCommand }  = require('../middleware/validateCommand');
const commandService       = require('../services/commandService');

// POST /api/commands
// Body: { siteId, lineId, machineId, command, params }
// Called by the React Native app to control the PLC
router.post('/', protect, validateCommand, async (req, res, next) => {
  try {
    const { siteId, lineId, machineId, command, params = {} } = req.body;

    const result = await commandService.sendCommand({
      siteId,
      lineId,
      machineId,
      command,
      params,
      issuedBy: req.user?.id,
    });

    res.status(200).json({
      success:   true,
      commandId: result.commandId,
      topic:     result.topic,
      timestamp: result.timestamp,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/commands/history/:machineId
// Returns the last N commands sent to a machine
router.get('/history/:machineId', protect, async (req, res, next) => {
  try {
    const limit   = parseInt(req.query.limit) || 50;
    const history = await commandService.getCommandHistory(req.params.machineId, limit);
    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
});

module.exports = router;