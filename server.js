require('dotenv').config();

const http = require('http');
const app  = require('./app');

const { initWebSocketServer }    = require('./services/websocketService');
const { startTelemetryListener } = require('./services/telemetryService');
const { startPgListener, stopPgListener } = require('./services/pgListenerService');
const { connectDB }              = require('./config/db');
const { client: redis }          = require('./config/redis');
const logger                     = require('./utils/logger');

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
initWebSocketServer(server);

const waitForRedis = () => new Promise((resolve) => {
  if (redis.isReady) return resolve();
  const timeout = setTimeout(() => resolve(), 5000);
  redis.once('ready', () => { clearTimeout(timeout); resolve(); });
});

const start = async () => {
  try {
    await connectDB();

    await waitForRedis();
    if (redis.isReady) {
      const keys = await redis.keys('telemetry:latest:*');
      if (keys.length) {
        await redis.del(keys);
        logger.info(`Flushed ${keys.length} stale telemetry cache key(s)`);
      }
    }

    await startTelemetryListener();
    await startPgListener();          // ← only addition

    server.listen(PORT, () => {
      logger.info(`PLC Backend running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err.message);
    process.exit(1);
  }
};

// Clean shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down');
  await stopPgListener();
  server.close(() => process.exit(0));
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down');
  await stopPgListener();
  server.close(() => process.exit(0));
});

start();