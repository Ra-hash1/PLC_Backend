const { WebSocketServer, WebSocket } = require('ws');
const logger = require('../utils/logger');

// ─── In-memory map: machineId → Set of WS clients ─────
const machineClients = new Map();

let wss = null;

// ─── Init — attach to the HTTP server ─────────────────
const initWebSocketServer = (httpServer) => {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    const connectionId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    ws._connectionId = connectionId;

    logger.info(`WS client connected [${connectionId}]`);

    ws.on('message', (rawMsg) => {
      try {
        const msg = JSON.parse(rawMsg);

        // Accept both legacy { type: 'subscribe' } and mobile-app { action: 'subscribe' }
        const isSubscribe =
          (msg.type === 'subscribe' || msg.action === 'subscribe') && msg.machineId;

        if (isSubscribe) {
          const { machineId, siteId, lineId } = msg;
          subscribeClient(ws, machineId, { siteId, lineId });
          ws.send(JSON.stringify({ type: 'subscribed', machineId }));
          logger.info(`WS [${connectionId}] subscribed → machine: ${machineId} site: ${siteId || '-'} line: ${lineId || '-'}`);

          // Send latest telemetry as a 'snapshot' (DB dump, not live data).
          // Frontend treats 'snapshot' differently from live 'telemetry' frames —
          // it loads the data into state but does NOT mark the machine as live.
          const { getLatestTelemetry } = require('./telemetryService');
          getLatestTelemetry(machineId)
            .then((snapshot) => {
              if (snapshot && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
              }
            })
            .catch((err) => logger.error('Failed to send snapshot:', err.message));
        }

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (e) {
        logger.error('WS message parse error:', e.message);
      }
    });

    ws.on('close', () => {
      removeClient(ws);
      logger.info(`WS client disconnected [${connectionId}]`);
    });

    ws.on('error', (err) => logger.error('WS error:', err.message));

    ws.send(JSON.stringify({ type: 'connected', message: 'PLC Backend WS ready' }));
  });

  logger.info('WebSocket server initialised');
};

const subscribeClient = (ws, machineId, meta = {}) => {
  if (!machineClients.has(machineId)) {
    machineClients.set(machineId, new Set());
  }
  machineClients.get(machineId).add(ws);
  ws._machineId = machineId;
  ws._siteId    = meta.siteId || null;
  ws._lineId    = meta.lineId || null;
};

const removeClient = (ws) => {
  const machineId = ws._machineId;
  if (machineId && machineClients.has(machineId)) {
    machineClients.get(machineId).delete(ws);
  }
};

const broadcastToMachine = (machineId, payload) => {
  const clients = machineClients.get(machineId);
  if (!clients || clients.size === 0) return;

  const message = JSON.stringify(payload);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  });
};

const broadcastTelemetry = (machineId, telemetryData) => {
  broadcastToMachine(machineId, { type: 'telemetry', data: telemetryData });
};

module.exports = {
  initWebSocketServer,
  broadcastToMachine,
  broadcastTelemetry,
};