# PLC Backend

Node.js + Express backend for PLC remote monitoring and control via a React Native app.

## Architecture

```
React Native App
  │
  ├── POST /api/commands       → Command dispatch → MQTT → ESP32 → PLC
  └── WSS  /                   → Real-time telemetry & alarm events
          ↑
  ESP32 / AWS IoT pushes telemetry → POST /api/telemetry → Redis + PostgreSQL + WS broadcast
```

## Folder Structure

```
plc-backend/
├── config/
│   ├── db.js              PostgreSQL pool
│   ├── redis.js           ioredis client
│   └── mqtt.js            MQTT topic helpers
├── middleware/
│   ├── authMiddleware.js  JWT protect + role guard
│   ├── errorHandler.js    Global error handler
│   ├── requestLogger.js   Coloured request logs
│   └── validateCommand.js PLC command payload validation
├── routes/
│   ├── authRoutes.js      POST /api/auth/register|login
│   ├── commandRoutes.js   POST /api/commands
│   ├── telemetryRoutes.js POST|GET /api/telemetry
│   ├── machineRoutes.js   GET|POST /api/machines
│   └── alarmRoutes.js     GET|POST|PUT /api/alarms
├── services/
│   ├── authService.js
│   ├── commandService.js
│   ├── telemetryService.js
│   ├── machineService.js
│   ├── alarmService.js
│   └── websocketService.js
├── tests/
├── utils/
│   ├── logger.js
│   ├── machineHelpers.js
│   ├── migrate.js         DB table creation script
│   └── responseHelper.js
├── app.js
└── server.js
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your DB, Redis, JWT values

# 3. Create database tables
node utils/migrate.js

# 4. Start dev server
npm run dev

# 5. Run tests
npm test
```

## API Reference

| Method | Endpoint                            | Auth | Description                        |
|--------|-------------------------------------|------|------------------------------------|
| POST   | /api/auth/register                  | No   | Register user                      |
| POST   | /api/auth/login                     | No   | Login, get JWT                     |
| POST   | /api/commands                       | Yes  | Send command to PLC                |
| GET    | /api/commands/history/:machineId    | Yes  | Command history                    |
| POST   | /api/telemetry                      | No   | Ingest telemetry from ESP32        |
| GET    | /api/telemetry/:machineId/latest    | Yes  | Latest machine snapshot            |
| GET    | /api/telemetry/:machineId/history   | Yes  | Historical telemetry               |
| GET    | /api/machines                       | Yes  | List all machines                  |
| GET    | /api/machines/:machineId            | Yes  | Single machine + current status    |
| POST   | /api/machines                       | Admin| Register new machine               |
| PUT    | /api/machines/:machineId/mode       | Yes  | Set MODE 1 / MODE 2                |
| GET    | /api/alarms/:machineId              | Yes  | Get alarms for machine             |
| POST   | /api/alarms                         | No   | Ingest alarm from ESP32            |
| PUT    | /api/alarms/:alarmId/acknowledge    | Yes  | Acknowledge alarm                  |

## WebSocket

Connect to `ws://localhost:3000` then send:

```json
{ "type": "subscribe", "machineId": "machine_01" }
```

You will receive messages in these shapes:

```json
// Telemetry (matches React Native app handler)
{ "type": "telemetry", "data": { "status": "running", "machineId": "machine_01" } }

// Command issued
{ "type": "command_issued", "data": { "commandId": "...", "command": "start" } }

// Alarm
{ "type": "alarm", "data": { "alarmCode": "E01", "severity": "WARNING" } }

// Alarm cleared
{ "type": "alarm_cleared", "data": { "machineId": "machine_01" } }
```

## Machine Identity

Matches the React Native app constants:

| Key       | Example      |
|-----------|--------------|
| siteId    | site_01      |
| lineId    | line_01      |
| machineId | machine_01   |
