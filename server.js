// ✅ Load .env ONLY in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const http = require('http');
const app  = require('./app');

const { initWebSocketServer }                        = require('./services/websocketService');
const { startTelemetryListener, stopTelemetryListener } = require('./services/telemetryService');
const { startPgListener, stopPgListener }            = require('./services/pgListenerService');
const { connectDB }              = require('./config/db');
const { client: redis }          = require('./config/redis');
const logger                     = require('./utils/logger');

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
initWebSocketServer(server);

// ✅ Safe Redis wait (won’t crash if Redis disabled)
const waitForRedis = () => new Promise((resolve) => {
  if (!redis || redis.isReady) return resolve();

  const timeout = setTimeout(() => resolve(), 5000);

  redis.once('ready', () => {
    clearTimeout(timeout);
    resolve();
  });
});

const start = async () => {
  try {
    // ✅ Connect DB first
    await connectDB();

    // ✅ Handle Redis safely
    await waitForRedis();

    if (redis && redis.isReady) {
      try {
        const keys = await redis.keys('telemetry:latest:*');
        if (keys.length) {
          await redis.del(keys);
          logger.info(`Flushed ${keys.length} stale telemetry cache key(s)`);
        }
      } catch (err) {
        logger.warn('Redis cleanup failed:', err.message);
      }
    }

    // ✅ Start services
    await startTelemetryListener();
    await startPgListener();

    server.listen(PORT, () => {
      logger.info(
        `🚀 PLC Backend running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`
      );
    });

  } catch (err) {
    logger.error('❌ Failed to start server:', err.message);
    process.exit(1);
  }
};

// ✅ Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} received — shutting down`);
  await Promise.all([stopPgListener(), stopTelemetryListener()]);
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// 🚀 Start app
start();