const bcrypt = require('bcryptjs'); // pure-JS: no native build needed on Railway/Docker
const jwt    = require('jsonwebtoken');
const { pool } = require('../config/db');
const { createError } = require('../middleware/errorHandler');

const SALT_ROUNDS = 10;

const register = async ({ name, email, password, role = 'operator' }) => {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw createError('Email already registered', 409);
  }

  const hash = await bcrypt.hash(password, SALT_ROUNDS);

  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id, name, email, role`,
    [name, email, hash, role]
  );

  const user  = rows[0];
  const token = signToken(user);

  return { user, token };
};

const login = async ({ email, password }) => {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE email = $1',
    [email]
  );

  if (rows.length === 0) throw createError('Invalid credentials', 401);

  const user  = rows[0];
  const match = await bcrypt.compare(password, user.password_hash);

  if (!match) throw createError('Invalid credentials', 401);

  const token = signToken(user);

  return {
    user:  { id: user.id, name: user.name, email: user.email, role: user.role },
    token,
  };
};

const signToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

module.exports = { register, login };
