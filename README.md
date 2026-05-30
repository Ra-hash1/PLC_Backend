# PLC Backend

Node.js + Express backend for industrial PLC remote monitoring and control. Receives telemetry from an AWS Lambda pipeline, broadcasts real-time data to dashboard clients over WebSocket, and exposes a REST API for commands, history, and CSV export.

---

## Architecture

```
ESP32 / PLC Firmware
  └── Sends telemetry payload to AWS Lambda
          │
          ├── INSERT INTO telemetry (PostgreSQL)
          │     └── AFTER INSERT trigger: notify_telemetry_insert()
          │           └── pg_notify('telemetry_channel', {id, machine_id, ts})
          │                 └── telemetryService LISTEN
          │                       ├── SELECT * WHERE id = $rowId  (PK lookup)
          │                       ├── Redis cache update (optional)
          │                       └── broadcastTelemetry() → WS clients
          │
          └── UPSERT machine_state (PostgreSQL)
                └── BEFORE trigger: sync_machine_state_from_payload()
                      └── Extracts PLC flags from payload → dedicated columns
                └── AFTER UPDATE trigger: notify_machine_status_change()
                      └── pg_notify('machine_status_changed', {machineId, flags...})
                            └── pgListenerService LISTEN
                                  ├── Session / runtime tracking
                                  └── broadcastMachineStatus() → WS clients

React Dashboard
  ├── WebSocket ←→ Node.js  (real-time telemetry, machine status, alarms)
  └── REST API  →  Node.js  (auth, commands, telemetry history, CSV export)
```

> **Why NOTIFY instead of direct ingest?**  
> The Lambda writes to PostgreSQL atomically. The Node.js backend never receives the raw payload directly — it wakes up via `pg_notify`, fetches the full row by primary key, and broadcasts it. This keeps the two systems decoupled and avoids the 8 KB `pg_notify` payload limit.

---

## Folder Structure

```
plc-backend/
├── config/
│   ├── db.js                  PostgreSQL pool (pg)
│   └── redis.js               Redis client (ioredis) — optional, graceful fallback
├── middleware/
│   ├── authMiddleware.js      JWT protect + role guard
│   ├── errorHandler.js        Global error handler
│   ├── requestLogger.js       Coloured request logs
│   └── validateCommand.js     PLC command payload validation
├── routes/
│   ├── authRoutes.js          POST /api/auth/register|login
│   ├── commandRoutes.js       POST /api/commands
│   ├── dashboardRoutes.js     GET  /api/dashboard/*
│   ├── machineRoutes.js       GET|POST|PUT /api/machines
│   ├── alarmRoutes.js         GET|POST|PUT /api/alarms
│   └── telemetryRoutes.js     GET  /api/telemetry/*
├── services/
│   ├── authService.js         JWT issue + verification
│   ├── commandService.js      Command dispatch via MQTT
│   ├── telemetryService.js    PostgreSQL LISTEN, mapRow, history, export helpers
│   ├── pgListenerService.js   machine_status_changed LISTEN + session tracking
│   ├── machineService.js      Machine CRUD
│   ├── alarmService.js        Alarm management
│   └── websocketService.js    WS server, subscribe/broadcast
├── scripts/
│   ├── migrate_v3.js          PLC state columns, production tables, indexes
│   ├── migrate_v4.js          Restore base telemetry columns (current_actual etc.)
│   ├── migrate_v5.js          Add canopen_nodes + raw_payload columns
│   ├── migrate_v6.js          Fix notify_telemetry_insert() payload size limit
│   ├── migrate_machine_state_v2.js   machine_state schema columns
│   ├── install_machine_state_triggers.js  BEFORE/AFTER triggers on machine_state
│   ├── add_cycle_count.js     One-off: add cycle_count column
│   ├── check_schema.js        Diagnostic: dump telemetry columns
│   ├── check_notify_fn.js     Diagnostic: print notify function body + latest row
│   └── check_telemetry_setup.js  Diagnostic: columns, triggers, functions
├── utils/
│   ├── logger.js              Structured console logger
│   └── responseHelper.js      Standard JSON response helpers
├── app.js                     Express app setup
└── server.js                  HTTP server + WS attachment + listener start
```

---

## Setup

### Prerequisites

- Node.js >= 18
- PostgreSQL (Railway or local)
- Redis (optional — app runs without it)

### Install & Run

```bash
npm install
cp .env.example .env    # fill in DB, Redis, JWT values
npm run dev             # nodemon dev server
npm start               # production
```

### Run DB Migrations (in order)

```bash
node scripts/migrate_v3.js
node scripts/migrate_v4.js
node scripts/migrate_v5.js
node scripts/migrate_v6.js
node scripts/install_machine_state_triggers.js
```

Each script is idempotent — safe to re-run.

---

## Environment Variables

| Variable | Description |
|---|---|
| `PGHOST` | PostgreSQL host |
| `PGPORT` | PostgreSQL port (default 5432) |
| `PGUSER` | PostgreSQL user |
| `PGPASSWORD` | PostgreSQL password |
| `PGDATABASE` | PostgreSQL database name |
| `REDIS_URL` | Redis connection URL (optional) |
| `JWT_SECRET` | Secret for JWT signing |
| `PORT` | HTTP server port (default 5000) |

---

## API Reference

### Auth

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | No | Register user |
| POST | `/api/auth/login` | No | Login, returns JWT |

### Dashboard

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/dashboard/sites` | Yes | All sites with machine counts |
| GET | `/api/dashboard/sites/:siteId/overview` | Yes | Machines for a site |
| GET | `/api/dashboard/machine/:machineId` | Yes | Machine status + production counters |

### Machines

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/machines` | Yes | List all machines |
| GET | `/api/machines/:machineId` | Yes | Machine details |
| POST | `/api/machines` | Admin | Register new machine |
| PUT | `/api/machines/:machineId/mode` | Yes | Set MODE 1 / MODE 2 |

### Commands

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/commands` | Yes | Dispatch start/stop command |
| GET | `/api/commands/history/:machineId` | Yes | Command history |

### Telemetry

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/telemetry/:machineId/latest` | Yes | Latest snapshot (Redis → DB) |
| GET | `/api/telemetry/:machineId/history` | Yes | Historical rows (paginated) |
| GET | `/api/telemetry/:machineId/count` | Yes | Row count for a time range |
| GET | `/api/telemetry/:machineId/array-widths` | Yes | Max servo + CANopen node array lengths |

#### History query parameters

| Parameter | Type | Description |
|---|---|---|
| `from` | ISO datetime | Start of range (UTC) |
| `to` | ISO datetime | End of range (UTC) |
| `limit` | integer | Rows per page (default 100) |
| `offset` | integer | Page offset — default (DESC) mode only |
| `after_id` | integer | Cursor PK — switches to ASC cursor mode for export |

**Cursor mode** (`after_id` present): returns rows in ascending ID order, immune to concurrent inserts during export.  
**Default mode** (no `after_id`): returns newest-first with offset, for dashboard display.

### Alarms

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/alarms/:machineId` | Yes | Alarms for machine |
| PUT | `/api/alarms/:alarmId/acknowledge` | Yes | Acknowledge alarm |

---

## WebSocket Protocol

The WS server is attached to the same HTTP server as Express.

**Subscribe (client → server):**
```json
{ "action": "subscribe", "siteId": "site_01", "lineId": "line_01", "machineId": "machine_01" }
```

**Server → client message types:**

| Type | Description |
|---|---|
| `connected` | Subscription acknowledged |
| `disconnected` | Connection closed |
| `snapshot` | Initial DB row delivered on connect (do not treat as live data) |
| `telemetry` | Live telemetry frame — `{ type, machineId, data: { ...mapRow fields } }` |
| `machine_status` | DB status change — `{ type, status, machineId, plcFeedbackFresh, machineActuallyRunning, ... }` |
| `alarm` | New alarm — `{ type, data: { ... } }` |
| `alarm_cleared` | Alarm resolved — `{ type }` |

---

## Telemetry Schema

Key columns in the `telemetry` table:

| Column | Type | Source |
|---|---|---|
| `id` | SERIAL | Auto |
| `machine_id`, `site_id`, `line_id` | VARCHAR | Lambda |
| `ts` | TIMESTAMPTZ | Lambda |
| `servos` | JSONB | Lambda — array of per-drive objects (30 fields each) |
| `canopen_nodes` | JSONB | Lambda — array of CAN bus node objects (16 fields each) |
| `raw_payload` | JSONB | Lambda — full event payload for debugging |
| `plc_feedback_fresh` … `remote_start_allowed` | BOOLEAN | Lambda / trigger |
| `axis_error_id`, `diagnostic_word` | INTEGER | Lambda |
| `total_runtime_seconds` … `production_rate_ppm` | NUMERIC | pgListenerService |
| `cycle_count` | BIGINT | ESP32 firmware (future) |

> `raw_payload` is intentionally excluded from the `pg_notify` broadcast (migration v6) to stay under PostgreSQL's 8 KB NOTIFY limit. The Node.js listener re-fetches the full row by PK on each notification.

---

## Machine Identity

| Key | Example |
|---|---|
| `siteId` | `site_01` |
| `lineId` | `line_01` |
| `machineId` | `machine_01` |
