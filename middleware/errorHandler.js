const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const message    = err.message    || 'Internal Server Error';

  if (process.env.NODE_ENV !== 'production') {
    console.error(`❌ [${req.method}] ${req.path} — ${message}`);
    if (err.stack) console.error(err.stack);
  }

  res.status(statusCode).json({
    error:   message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
};

// ─── Helper: throw with a status code ─────────────────
const createError = (message, statusCode = 500) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

module.exports = { errorHandler, createError };
