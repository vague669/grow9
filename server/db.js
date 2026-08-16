const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DATABASE_URL ? undefined : (process.env.PGHOST || 'localhost'),
  user: process.env.DATABASE_URL ? undefined : (process.env.PGUSER || 'postgres'),
  password: process.env.DATABASE_URL ? undefined : (process.env.PGPASSWORD || 'devpass'),
  database: process.env.DATABASE_URL ? undefined : (process.env.PGDATABASE || 'growtopia_dev'),
  port: process.env.DATABASE_URL ? undefined : (process.env.PGPORT || 5432),
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      gems INTEGER NOT NULL DEFAULT 0,
      inventory JSONB NOT NULL DEFAULT '[]',
      worn JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS worlds (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      tiles JSONB NOT NULL,
      plants JSONB NOT NULL DEFAULT '[]',
      drops JSONB NOT NULL DEFAULT '[]',
      locked BOOLEAN NOT NULL DEFAULT false,
      lock_type TEXT,
      access JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS friends JSONB NOT NULL DEFAULT '[]';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS shops JSONB NOT NULL DEFAULT '[]';`);
  // Global admin banı (/sban) — kalıcı, sunucu geneli, dünya bazlı değil.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_transactions (
      id SERIAL PRIMARY KEY,
      world_name TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      seller_id INTEGER NOT NULL REFERENCES users(id),
      buyer_id INTEGER NOT NULL REFERENCES users(id),
      item_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log('[db] schema ready');
}

module.exports = { pool, initSchema };
