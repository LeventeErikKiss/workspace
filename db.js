const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbFile = process.env.DB_FILE || path.join(__dirname, 'app.db');
const db = new sqlite3.Database(dbFile);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function init() {
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
}

module.exports = {
  db,
  run,
  get,
  all,
  init
};
