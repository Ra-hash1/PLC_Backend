// ─── Valid commands matching the React Native app ─────
const VALID_COMMANDS = ['start', 'stop', 'reset', 'setSpeed'];

const validateCommand = (req, res, next) => {
  const { siteId, lineId, machineId, command, params } = req.body;

  if (!siteId || !lineId || !machineId) {
    return res.status(400).json({
      error: 'Missing required fields: siteId, lineId, machineId',
    });
  }

  if (!command || !VALID_COMMANDS.includes(command)) {
    return res.status(400).json({
      error: `Invalid command. Must be one of: ${VALID_COMMANDS.join(', ')}`,
    });
  }

  if (command === 'setSpeed') {
    const speed = params?.speed;
    if (speed === undefined || typeof speed !== 'number' || speed < 0) {
      return res.status(400).json({
        error: 'setSpeed requires params.speed as a positive number',
      });
    }
  }

  next();
};

module.exports = { validateCommand };
