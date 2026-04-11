const express = require('express');
const cors = require('cors');
const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/requestLogger');

// ─── Routes ────────────────────────────────────────────
const commandRoutes   = require('./routes/commandRoutes');
const telemetryRoutes = require('./routes/telemetryRoutes');
const machineRoutes   = require('./routes/machineRoutes');
const authRoutes      = require('./routes/authRoutes');
const alarmRoutes     = require('./routes/alarmRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');

const app = express();

// ✅ CORS CONFIG (FIXED)
const allowedOrigins = [
  "http://localhost:5173",
  "https://plc.up.railway.app"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // allow Postman / server calls

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error("CORS not allowed"));
    }
  },
  credentials: true
}));

// ─── Core Middleware ───────────────────────────────────
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

// ─── Global Error Handler ──────────────────────────────
app.use(errorHandler);

module.exports = app;