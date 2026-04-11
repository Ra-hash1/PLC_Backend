const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getAllSites,
  getMachinesBySite,
  getMachineState,
  getDashboardBySite,
} = require('../services/machineService');

// GET /api/dashboard/sites
router.get('/sites', protect, async (req, res, next) => {
  try {
    const sites = await getAllSites();
    res.json({ success: true, data: sites });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/sites/:siteId/machines
router.get('/sites/:siteId/machines', protect, async (req, res, next) => {
  try {
    const machines = await getMachinesBySite(req.params.siteId);
    res.json({ success: true, data: machines });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/sites/:siteId/overview
router.get('/sites/:siteId/overview', protect, async (req, res, next) => {
  try {
    const data = await getDashboardBySite(req.params.siteId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/machine/:machineId
router.get('/machine/:machineId', protect, async (req, res, next) => {
  try {
    const data = await getMachineState(req.params.machineId);
    if (!data) return res.status(404).json({ success: false, error: 'Machine not found' });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;