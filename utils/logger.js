const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

const timestamp = () => new Date().toISOString();

const logger = {
  error: (msg, meta) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.error)
      console.error(`[${timestamp()}] ❌ ERROR  ${msg}`, meta || '');
  },
  warn: (msg, meta) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.warn)
      console.warn(`[${timestamp()}] ⚠️  WARN   ${msg}`, meta || '');
  },
  info: (msg, meta) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.info)
      console.log(`[${timestamp()}] ℹ️  INFO   ${msg}`, meta || '');
  },
  debug: (msg, meta) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.debug)
      console.log(`[${timestamp()}] 🐛 DEBUG  ${msg}`, meta || '');
  },
};

module.exports = logger;
