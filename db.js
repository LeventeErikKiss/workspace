const path = require('path');

const usePostgres = Boolean(process.env.DATABASE_URL);

let db = null;
let pool = null;

if (usePostgres) {
  const { Pool } = require('pg');
  const pgsslRaw = String(process.env.PGSSL || '').toLowerCase();
  const forceSsl = pgsslRaw === 'true';
  const disableSsl = pgsslRaw === 'false';
  let sslFromUrl = true;
  try {
    const parsed = new URL(process.env.DATABASE_URL);
    const sslMode = parsed.searchParams.get('sslmode');
    if (sslMode && sslMode.toLowerCase() === 'disable') {
      sslFromUrl = false;
    }
  } catch (err) {
    sslFromUrl = true;
  }
  const useSsl = disableSsl ? false : (forceSsl ? true : sslFromUrl);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false
  });
} else {
  const sqlite3 = require('sqlite3').verbose();
  const dbFile = process.env.DB_FILE || path.join(__dirname, 'app.db');
  db = new sqlite3.Database(dbFile);
}

function toPgSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizePgSql(sql) {
  if (sql.startsWith('INSERT OR IGNORE INTO friends')) {
    return sql.replace('INSERT OR IGNORE INTO friends', 'INSERT INTO friends') + ' ON CONFLICT DO NOTHING';
  }

  if (sql.startsWith('INSERT OR IGNORE INTO requests')) {
    return sql.replace('INSERT OR IGNORE INTO requests', 'INSERT INTO requests') + ' ON CONFLICT DO NOTHING';
  }

  if (sql.startsWith('INSERT OR REPLACE INTO events')) {
    return (
      'INSERT INTO events (email, eventId, type, name, city, date, rawDate, url, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (email, eventId, type) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city, date = EXCLUDED.date, rawDate = EXCLUDED.rawDate, url = EXCLUDED.url, createdAt = EXCLUDED.createdAt'
    );
  }

  if (sql.startsWith('INSERT OR REPLACE INTO locations')) {
    return (
      'INSERT INTO locations (email, lat, lng, updatedAt) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (email) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, updatedAt = EXCLUDED.updatedAt'
    );
  }

  return sql;
}

async function run(sql, params = []) {
  if (usePostgres) {
    const normalized = normalizePgSql(sql);
    const pgSql = toPgSql(normalized);
    const result = await pool.query(pgSql, params);
    return result;
  }

  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function get(sql, params = []) {
  if (usePostgres) {
    const normalized = normalizePgSql(sql);
    const pgSql = toPgSql(normalized);
    const result = await pool.query(pgSql, params);
    return result.rows[0] || null;
  }

  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

async function all(sql, params = []) {
  if (usePostgres) {
    const normalized = normalizePgSql(sql);
    const pgSql = toPgSql(normalized);
    const result = await pool.query(pgSql, params);
    return result.rows || [];
  }

  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function init() {
  if (usePostgres) {
    await run(
      `CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        password TEXT,
        createdAt TEXT NOT NULL
      )`
    );

    await run(
      `CREATE TABLE IF NOT EXISTS avatars (
        email TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )`
    );

    await run(
      `CREATE TABLE IF NOT EXISTS friends (
        email TEXT NOT NULL,
        friendEmail TEXT NOT NULL,
        PRIMARY KEY (email, friendEmail)
      )`
    );

    await run(
      `CREATE TABLE IF NOT EXISTS requests (
        email TEXT NOT NULL,
        fromEmail TEXT NOT NULL,
        PRIMARY KEY (email, fromEmail)
      )`
    );

    await run(
      `CREATE TABLE IF NOT EXISTS events (
        email TEXT NOT NULL,
        eventId TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        city TEXT,
        date TEXT,
        rawDate TEXT,
        url TEXT,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (email, eventId, type)
      )`
    );

    await run(
      `CREATE TABLE IF NOT EXISTS locations (
        email TEXT PRIMARY KEY,
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        updatedAt BIGINT NOT NULL
      )`
    );

    await run(
      `CREATE TABLE IF NOT EXISTS mitid_accounts (
        cpr TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )`
    );
    return;
  }

  await run(
    `CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password TEXT,
      createdAt TEXT NOT NULL
    )`
  );

  const userColumns = await all('PRAGMA table_info(users)');
  const hasPassword = userColumns.some(col => col.name === 'password');
  if (!hasPassword) {
    await run('ALTER TABLE users ADD COLUMN password TEXT');
  }

  await run('ALTER TABLE users ADD COLUMN password TEXT').catch(() => null);

  await run(
    `CREATE TABLE IF NOT EXISTS avatars (
      email TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY(email) REFERENCES users(email)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS friends (
      email TEXT NOT NULL,
      friendEmail TEXT NOT NULL,
      PRIMARY KEY (email, friendEmail)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS requests (
      email TEXT NOT NULL,
      fromEmail TEXT NOT NULL,
      PRIMARY KEY (email, fromEmail)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS events (
      email TEXT NOT NULL,
      eventId TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      city TEXT,
      date TEXT,
      rawDate TEXT,
      url TEXT,
      createdAt TEXT NOT NULL,
      PRIMARY KEY (email, eventId, type)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS locations (
      email TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      updatedAt INTEGER NOT NULL
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS mitid_accounts (
      cpr TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(email) REFERENCES users(email)
    )`
  );
}

module.exports = {
  db,
  run,
  get,
  all,
  init
};
