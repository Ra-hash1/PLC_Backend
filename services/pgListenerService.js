const { Client }             = require('pg');
const { broadcastToMachine } = require('./websocketService');
const logger                 = require('../utils/logger');

let listenerClient = null;
let reconnectTimer = null;

// ── Use the same individual env vars your pool uses ──
const getClientConfig = () => ({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'plc_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false,
});

const startPgListener = async () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  listenerClient = new Client(getClientConfig());

  listenerClient.on('error', (err) => {
    logger.error('PG listener error:', err.message);
    scheduleReconnect();
  });

  listenerClient.on('end', () => {
    logger.warn('PG listener connection ended');
    scheduleReconnect();
  });

  listenerClient.on('notification', (n) => {
    try {
      const { machineId, status, ts } = JSON.parse(n.payload);
      logger.info(`DB trigger → machine [${machineId}] status changed to: ${status}`);
      broadcastToMachine(machineId, {
        type:   'machine_status',
        status,
        ts,
        source: 'db_trigger',
      });
    } catch (e) {
      logger.error('PG notification parse error:', e.message);
    }
  });

  try {
    await listenerClient.connect();
    await listenerClient.query('LISTEN machine_status_changed');
    logger.info('PG listener ready — watching machine_status_changed');
  } catch (err) {
    logger.error('PG listener connect failed:', err.message);
    scheduleReconnect();
  }
};

const scheduleReconnect = () => {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    logger.info('PG listener reconnecting...');
    startPgListener();
  }, 5000);
};

const stopPgListener = async () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (listenerClient) {
    await listenerClient.end().catch(() => {});
    listenerClient = null;
  }
};

module.exports = { startPgListener, stopPgListener };