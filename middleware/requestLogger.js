const logger = require('../utils/logger');

const requestLogger = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const msg = `[${res.statusCode}] ${req.method} ${req.originalUrl} — ${duration}ms`;

    if (res.statusCode >= 500)      logger.error(msg);
    else if (res.statusCode >= 400) logger.warn(msg);
    else                            logger.info(msg);
  });

  next();
};

module.exports = { requestLogger };