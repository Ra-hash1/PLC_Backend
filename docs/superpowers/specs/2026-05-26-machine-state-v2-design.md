# Machine State V2 — Design Spec
**Date:** 2026-05-26  
**Status:** Approved  
**Scope:** Backend + Frontend  

---

## 1. Problem Statement

The current `machine_state` table stores only a coarse `status` string (RUNNING / STOPPED / FAULT etc.) and a raw `payload` JSONB blob. The PLC developer has identified 16 structured fields that the ESP32/PLC can write or that the backend can derive, enabling:

- Richer, PLC-native boolean state flags (replaces status-string inference)
- Persistent runtime and production counters (survives server restarts)
- Per-session vs. all-time production tracking
- Real-time production rate (ppm)
- Explicit diagnostic fields (`axis_error_id`, `diagnostic_word`)

---

## 2. Architecture Overview

```
PLC/ESP32
  └─► UPDATE machine_state
        (writes: state flags, pouch_counter, axis_error_id, diagnostic_word)
        └─► PostgreSQL trigger fires
              └─► NOTIFY machine_status_changed  (payload includes boolean flags)
                    └─► pgListenerService.js
                          ├─► broadcastToMachine()  →  WS clients (flags, instant)
                          └─► Session logic
                                ├─► running=true  → reset session, write session_start_at
                                ├─► running=false → finalise totals
                                └─► 10s tick      → update session counters + ppm

Frontend LiveView
  ├─► WS stream  → PLC state flags (instant)
  └─► 3s poll    → /dashboard/machine/:id  → counters (session/total runtime + pouches + ppm)
```

---

## 3. Database Schema Changes

### 3.1 ALTER TABLE migration
File: `scripts/migrate_machine_state_v2.js`

```sql
ALTER TABLE machine_state

  -- PLC state flags (written by PLC/ESP32)
  ADD COLUMN plc_feedback_fresh       BOOLEAN,
  ADD COLUMN machine_ready_to_run     BOOLEAN,
  ADD COLUMN machine_actually_running  BOOLEAN,
  ADD COLUMN machine_faulted          BOOLEAN,
  ADD COLUMN machine_stopping         BOOLEAN,
  ADD COLUMN machine_disabled         BOOLEAN,
  ADD COLUMN remote_start_allowed     BOOLEAN,

  -- Diagnostics (written by PLC/ESP32)
  ADD COLUMN axis_error_id            INTEGER,
  ADD COLUMN diagnostic_word          INTEGER,

  -- Production counters
  -- pouch_counter: raw PLC cumulative counter (written by PLC)
  -- session_pouches, total_pouches: computed by backend
  ADD COLUMN pouch_counter            NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN session_pouches          NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN total_pouches            NUMERIC(14,2) DEFAULT 0,

  -- Runtime counters (computed by backend)
  ADD COLUMN session_runtime_seconds  BIGINT        DEFAULT 0,
  ADD COLUMN total_runtime_seconds    BIGINT        DEFAULT 0,

  -- Derived rate (computed by backend)
  ADD COLUMN production_rate_ppm      NUMERIC(10,2) DEFAULT 0,

  -- Backend helper: timestamp when current session started (survives restarts)
  ADD COLUMN session_start_at         TIMESTAMPTZ;
```

### 3.2 Existing DB trigger — payload extension
The existing PostgreSQL trigger that fires `NOTIFY machine_status_changed` must be updated to include the new boolean flags in its JSON payload:

```json
{
  "machineId": "M1",
  "status": "RUNNING",
  "ts": "2026-05-26T10:00:00Z",
  "plcFeedbackFresh": true,
  "machineReadyToRun": true,
  "machineActuallyRunning": true,
  "machineFaulted": false,
  "machineStopping": false,
  "machineDisabled": false,
  "remoteStartAllowed": true
}
```

> **Note:** Counters (`pouch_counter`, `session_runtime_seconds`, etc.) are NOT included in the WS push — they are fetched via the 3s poll.

---

## 4. Backend Changes

### 4.1 `scripts/migrate_machine_state_v2.js` (new)
- Idempotent migration: checks for column existence before adding
- Runs with `node scripts/migrate_machine_state_v2.js`
- Prints confirmation for each column added or skipped

### 4.2 `services/pgListenerService.js` (modified)
New responsibilities added to the existing service:

#### In-memory session map
```js
// machineId → { startAt: Date, lastPouchCounter: number }
const activeSessions = new Map()
```

#### On notification received
Parse existing `machine_status_changed` payload. Additionally:

1. **Running transition (`false → true` or `null → true`)**
   - `startAt = new Date()`
   - Write to DB: `session_start_at = now(), session_runtime_seconds = 0, session_pouches = 0`
   - Query DB for current `pouch_counter` (`SELECT pouch_counter FROM machine_state WHERE machine_id = $1`) to get `lastPouchCounter` (notification payload does not include it)
   - Store `{ startAt, lastPouchCounter }` in `activeSessions`

2. **Stop transition (`true → false`)**
   - If session entry exists: compute final session duration; accumulate into `total_runtime_seconds` and `total_pouches`
   - Write to DB: `total_runtime_seconds += elapsed, total_pouches += sessionPouches`
   - Remove from `activeSessions`

#### 10-second tick (`setInterval`)
For each machine in `activeSessions`:
- `sessionRuntimeSeconds = Math.floor((Date.now() - startAt) / 1000)`
- Fetch current `pouch_counter` from DB (single SELECT)
- `sessionPouches = currentPouchCounter - lastPouchCounter`
- `productionRatePpm = sessionRuntimeSeconds > 0 ? (sessionPouches / (sessionRuntimeSeconds / 60)) : 0`  
  *(session-average rate from start — not a rolling window)*
- Batch UPDATE: `session_runtime_seconds, session_pouches, production_rate_ppm`

#### Startup recovery
On `startPgListener()`, before registering the LISTEN:
```js
const { rows } = await pool.query(
  `SELECT machine_id, session_start_at, pouch_counter
   FROM machine_state
   WHERE machine_actually_running = true AND session_start_at IS NOT NULL`
)
rows.forEach(r => activeSessions.set(r.machine_id, {
  startAt: new Date(r.session_start_at),
  lastPouchCounter: Number(r.pouch_counter) || 0,
}))
```

### 4.3 `services/machineService.js` (modified)
`getMachineState()` maps 16 new columns to camelCase. No query change needed (already `SELECT *`):

```js
return {
  ...row,
  // existing fields
  siteId:     row.site_id    ?? null,
  lineId:     row.line_id    ?? null,
  machineId:  row.machine_id,
  status:     row.status     ?? null,
  lastSeenAt: row.ts ? new Date(row.ts).toISOString() : null,

  // NEW: PLC state flags
  plcFeedbackFresh:       row.plc_feedback_fresh        ?? null,
  machineReadyToRun:      row.machine_ready_to_run      ?? null,
  machineActuallyRunning: row.machine_actually_running  ?? null,
  machineFaulted:         row.machine_faulted           ?? null,
  machineStopping:        row.machine_stopping          ?? null,
  machineDisabled:        row.machine_disabled          ?? null,
  remoteStartAllowed:     row.remote_start_allowed      ?? null,

  // NEW: diagnostics
  axisErrorId:            row.axis_error_id             ?? null,
  diagnosticWord:         row.diagnostic_word           ?? null,

  // NEW: production counters
  pouchCounter:           row.pouch_counter             !== null ? Number(row.pouch_counter) : null,
  sessionPouches:         row.session_pouches           !== null ? Number(row.session_pouches) : null,
  totalPouches:           row.total_pouches             !== null ? Number(row.total_pouches) : null,

  // NEW: runtime counters
  sessionRuntimeSeconds:  row.session_runtime_seconds   !== null ? Number(row.session_runtime_seconds) : null,
  totalRuntimeSeconds:    row.total_runtime_seconds     !== null ? Number(row.total_runtime_seconds) : null,

  // NEW: rate
  productionRatePpm:      row.production_rate_ppm       !== null ? Number(row.production_rate_ppm) : null,
}
```

### 4.4 `services/websocketService.js` (no structural change)
`broadcastToMachine()` already sends arbitrary payloads. The `pgListenerService` will pass an enriched object — no changes needed in this file.

---

## 5. Frontend Changes

### 5.1 `src/hooks/useWebSocket.js` (modified)
The `machine_status` WS event handler extracts and exposes the new PLC state flags:

```js
// Added to hook state:
const [plcState, setPlcState] = useState({
  feedbackFresh: null, readyToRun: null, actuallyRunning: null,
  faulted: null, stopping: null, disabled: null, remoteStartAllowed: null,
})

// In the message handler, on type === 'machine_status':
setPlcState({
  feedbackFresh:      msg.plcFeedbackFresh      ?? null,
  readyToRun:         msg.machineReadyToRun     ?? null,
  actuallyRunning:    msg.machineActuallyRunning ?? null,
  faulted:            msg.machineFaulted        ?? null,
  stopping:           msg.machineStopping       ?? null,
  disabled:           msg.machineDisabled       ?? null,
  remoteStartAllowed: msg.remoteStartAllowed    ?? null,
})
```

Hook returns `plcState` alongside existing `decoded`, `connected`, `servos`, `dbStatus`.

### 5.2 `src/components/LiveView.jsx` (modified)

#### ① Session Overview
`RuntimeClock` component driven by `data?.sessionRuntimeSeconds` from poll (instead of `decoded?.deviceUptimeMs / 1000`).

`ProductionCard` component updated:
- Primary large number: `sessionPouches` (current session)
- Secondary line: `"Total: X pouches · Rate: Y ppm"`
- Source badge: shows `"PLC Live"` when `pouchCounter !== null`, else `"No Signal"`

#### ② Status Flags section — replaced
Old 4 `BoolCard` components (`Operation Enabled`, `Fault Active`, `Warning Active`, `Remote Active`) replaced with 6 PLC-native cards sourced from `plcState` (WS):

| Card label | Field | True color | False color |
|---|---|---|---|
| Ready to Run | `plcState.readyToRun` | green `#34d399` | dim |
| Running | `plcState.actuallyRunning` | green `#34d399` | dim |
| Faulted | `plcState.faulted` | red `#f87171` | green `#34d399` |
| Stopping | `plcState.stopping` | amber `#fbbf24` | dim |
| Disabled | `plcState.disabled` | amber `#fbbf24` | dim |
| Remote Start | `plcState.remoteStartAllowed` | blue `#60a5fa` | dim |

#### ③ System Diagnostics — two new rows
In the `DiagCard` (right panel), add after existing rows:
```js
{ label: 'Axis Error',      value: axisErrorId === 0 || axisErrorId == null ? 'No fault' : `0x${axisErrorId.toString(16).toUpperCase()}`, color: axisErrorId ? '#f87171' : undefined },
{ label: 'Diagnostic Word', value: diagnosticWord != null ? `0x${diagnosticWord.toString(16).toUpperCase().padStart(4,'0')}` : '—' },
```

#### ④ `isRunning` — dual-source
```js
// WS flag wins immediately; falls back to polled apiStatus
const isRunning = plcState.actuallyRunning ?? (apiStatus === 'RUNNING')
```
Start/Stop button disabled states use this, giving instant response on WS push without waiting for the next 3s poll cycle.

#### Removed / deprecated
- `decoded?.cycleCount` → no longer used in `ProductionCard`
- `decoded?.deviceUptimeMs` → no longer used in `RuntimeClock`
- The 4 old Status Flag `BoolCard` components

---

## 6. Data Flow Summary

| Field group | Written by | Transport | Frontend consumption |
|---|---|---|---|
| `plcFeedbackFresh`, `machineReadyToRun`, `machineActuallyRunning`, `machineFaulted`, `machineStopping`, `machineDisabled`, `remoteStartAllowed` | PLC → `machine_state` | WS `machine_status` event | `plcState` from `useWebSocket` |
| `axisErrorId`, `diagnosticWord` | PLC → `machine_state` | HTTP poll | `data` from 3s poll |
| `pouchCounter` | PLC → `machine_state` | HTTP poll | `data` from 3s poll |
| `sessionPouches`, `totalPouches`, `sessionRuntimeSeconds`, `totalRuntimeSeconds`, `productionRatePpm` | Backend → `machine_state` | HTTP poll | `data` from 3s poll |

---

## 7. Error Handling & Edge Cases

- **PLC fields are NULL until first PLC update**: All new columns are nullable; frontend renders `—` for null values.
- **Server restart**: `pgListenerService` re-hydrates `activeSessions` from DB rows where `machine_actually_running = true` on startup. No session data lost.
- **Rapid transitions**: If machine toggles running/stopped faster than the 10s tick, session data is still accurate because transition handler writes final totals immediately.
- **`pouch_counter` wraps or resets**: If `currentPouchCounter < lastPouchCounter`, treat as reset — use `currentPouchCounter` as the delta (not negative).
- **Migration safety**: Migration script is idempotent — checks `information_schema.columns` before each `ALTER TABLE ADD COLUMN`.

---

## 8. Files Changed

### Backend (`plc-backend`)
| File | Change type |
|------|-------------|
| `scripts/migrate_machine_state_v2.js` | **New** — idempotent migration |
| `services/pgListenerService.js` | **Modified** — session logic + 10s tick + startup recovery |
| `services/machineService.js` | **Modified** — `getMachineState()` maps 16 new columns |
| `scripts/update_machine_state_trigger.js` | **New** — queries current trigger source from `pg_proc`, prints updated SQL for DBA to apply (cannot auto-apply — trigger body is site-specific) |

### Frontend (`plc-frontend`)
| File | Change type |
|------|-------------|
| `src/hooks/useWebSocket.js` | **Modified** — extract + expose `plcState` from WS |
| `src/components/LiveView.jsx` | **Modified** — RuntimeClock, ProductionCard, StatusFlags, DiagCard |

---

## 9. Out of Scope
- Changes to the `telemetry` table or `telemetry_channel` flow (untouched)
- `cycle_count` column removal from `telemetry` (deprecated silently; removed in a future migration)
- New API routes (all data surfaces through existing `/dashboard/machine/:machineId`)
- Auth changes
- Mobile app changes
