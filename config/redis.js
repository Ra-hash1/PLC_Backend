const { createClient } = require('redis');
const logger = require('../utils/logger');

const client = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    reconnectStrategy: (retries) => {
      if (retries > 3) {
        logger.warn('Redis unavailable, running without cache');
        return false;
      }
      return 1000;
    },
  },
  password: process.env.REDIS_PASSWORD || undefined,
});

client.on('ready', () => {
  logger.info('Redis connected');
});

client.on('error', (err) => {
  if (err.code !== 'ECONNREFUSED') {
    logger.error('Redis error:', err.message);
  }
});

client.connect().catch(() => {
  logger.warn('Redis not available, continuing without cache');
});

client.delPattern = async (pattern) => {
  try {
    if (!client.isReady) return;
    const keys = await client.keys(pattern);
    if (keys.length) await client.del(keys);
  } catch (err) {
    logger.warn('Redis delPattern failed:', err.message);
  }
};

const getRedis = () => (client.isReady ? client : null);

module.exports = { client, getRedis };