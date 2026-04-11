const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'plc_db',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',

  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false } // change to true if cert works
    : false,

  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,

  // ✅ Production critical
  keepAlive: true,
  statement_timeout: 5000,
  query_timeout: 5000,
});

// Handle unexpected errors
pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL pool error:', err.message);
});

// Retry DB connection
const connectDB = async (retries = 5, delay = 2000) => {
  for (let i = 1; i <= retries; i++) {
    try {
      const client = await pool.connect();
      client.release();
      console.log('✅ PostgreSQL connected');
      return;
    } catch (err) {
      console.error(`❌ DB connection attempt ${i}/${retries} failed: ${err.message}`);

      if (i === retries) throw err;

      const backoff = delay * i; // exponential-ish
      console.log(`⏳ Retrying in ${backoff / 1000}s...`);
      await new Promise((res) => setTimeout(res, backoff));
    }
  }
};

module.exports = { pool, connectDB };