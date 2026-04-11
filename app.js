const express    = require('express');
const cors       = require('cors');
const { errorHandler }    = require('./middleware/errorHandler');
const { requestLogger }   = require('./middleware/requestLogger');

// ─── Routes ────────────────────────────────────────────
const commandRoutes   = require('./routes/commandRoutes');
const telemetryRoutes = require('./routes/telemetryRoutes');
const machineRoutes   = require('./routes/machineRoutes');
const authRoutes      = require('./routes/authRoutes');
const alarmRoutes     = require('./routes/alarmRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');

const app = express();

// ─── Core Middleware ───────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// ─── Health Check ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Routes ────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/commands',  commandRoutes);
app.use('/api/telemetry', telemetryRoutes);
app.use('/api/machines',  machineRoutes);
app.use('/api/alarms',    alarmRoutes);
app.use('/api/dashboard', dashboardRoutes);

// ─── Global Error Handler (must be last) ───────────────
app.use(errorHandler);

module.exports = app;