const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { init, run, get, all } = require('./db');

const app = express();

const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || 'aproati555@gmail.com');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '123456-1234');

const corsOrigin = process.env.CORS_ORIGIN || '';
const allowedOrigins = corsOrigin
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: allowedOrigins.length > 0
  })
);
app.use(express.json({ limit: '1mb' }));

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeCpr(cpr) {
  return String(cpr || '').trim();
}

function getAdminCredentials(req) {
  const email = normalizeEmail(req.headers['x-admin-email'] || req.body?.email || req.query?.email);
  const password = String(req.headers['x-admin-password'] || req.body?.password || req.query?.password || '');
  return { email, password };
}

function isAdmin(req) {
  const { email, password } = getAdminCredentials(req);
  return Boolean(email && password && email === ADMIN_EMAIL && password === ADMIN_PASSWORD);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'admin unauthorized' });
  }
  next();
}

async function upsertUser(email, name, password) {
  const existing = await get('SELECT email FROM users WHERE email = ?', [email]);
  if (existing) {
    if (password) {
      await run('UPDATE users SET name = ?, password = ? WHERE email = ?', [name, password, email]);
    } else {
      await run('UPDATE users SET name = ? WHERE email = ?', [name, email]);
    }
  } else {
    await run('INSERT INTO users (email, name, password, createdAt) VALUES (?, ?, ?, ?)', [
      email,
      name,
      password || null,
      nowIso()
    ]);
  }
}

async function pruneEvents(email) {
  const now = new Date();
  const rows = await all(
    'SELECT eventId, rawDate FROM events WHERE email = ? AND rawDate IS NOT NULL AND rawDate != ""',
    [email]
  );
  for (const row of rows) {
    const parsed = new Date(row.rawDate);
    if (!Number.isNaN(parsed.getTime()) && parsed < now) {
      await run('DELETE FROM events WHERE email = ? AND eventId = ?', [email, row.eventId]);
    }
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/users/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }

    const user = await get('SELECT email, name, password, createdAt FROM users WHERE email = ?', [email]);

    if (password) {
      if (!user || !user.password) return res.status(401).json({ error: 'invalid credentials' });
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.status(401).json({ error: 'invalid credentials' });
      return res.json({ email: user.email, name: user.name, createdAt: user.createdAt });
    }

    if (user && user.password) {
      return res.status(401).json({ error: 'password required' });
    }

    if (!name) {
      return res.status(400).json({ error: 'name required' });
    }

    await upsertUser(email, name);
    const updated = await get('SELECT email, name, createdAt FROM users WHERE email = ?', [email]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'login failed' });
  }
});

app.post('/api/admin/login', (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'invalid admin credentials' });
  }
  res.json({ email: ADMIN_EMAIL });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const rows = await all('SELECT email, name, createdAt FROM users ORDER BY createdAt DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'admin users read failed' });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email required' });
    }

    const existing = await get('SELECT email FROM users WHERE LOWER(email) = LOWER(?)', [email]);
    if (existing) return res.status(409).json({ error: 'email exists' });

    const hashed = password ? await bcrypt.hash(password, 10) : null;
    await run('INSERT INTO users (email, name, password, createdAt) VALUES (?, ?, ?, ?)', [
      email,
      name,
      hashed,
      nowIso()
    ]);
    res.json({ email, name });
  } catch (err) {
    res.status(500).json({ error: 'admin user create failed' });
  }
});

app.delete('/api/admin/users/:email', requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    await run('BEGIN TRANSACTION');
    await run('DELETE FROM avatars WHERE email = ?', [email]);
    await run('DELETE FROM friends WHERE email = ? OR friendEmail = ?', [email, email]);
    await run('DELETE FROM requests WHERE email = ? OR fromEmail = ?', [email, email]);
    await run('DELETE FROM events WHERE email = ?', [email]);
    await run('DELETE FROM locations WHERE email = ?', [email]);
    await run('DELETE FROM users WHERE email = ?', [email]);
    await run('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await run('ROLLBACK').catch(() => null);
    res.status(500).json({ error: 'admin user delete failed' });
  }
});

app.post('/api/users/register', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, password required' });
    }

    const existing = await get('SELECT email FROM users WHERE LOWER(email) = LOWER(?)', [email]);
    if (existing) return res.status(409).json({ error: 'email exists' });

    const hashed = await bcrypt.hash(password, 10);
    await run('INSERT INTO users (email, name, password, createdAt) VALUES (?, ?, ?, ?)', [
      email,
      name,
      hashed,
      nowIso()
    ]);
    res.json({ email, name });
  } catch (err) {
    res.status(500).json({ error: 'register failed' });
  }
});

app.get('/api/mitid/:cpr', async (req, res) => {
  try {
    const cpr = normalizeCpr(req.params.cpr);
    if (!cpr) return res.status(400).json({ error: 'cpr required' });

    const mapping = await get('SELECT email FROM mitid_accounts WHERE cpr = ?', [cpr]);
    if (!mapping) return res.status(404).json({ error: 'not found' });

    const user = await get('SELECT email, name, createdAt FROM users WHERE email = ?', [mapping.email]);
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'mitid lookup failed' });
  }
});

app.post('/api/mitid/register', async (req, res) => {
  try {
    const cpr = normalizeCpr(req.body?.cpr);
    const name = String(req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);
    if (!cpr || !name || !email) {
      return res.status(400).json({ error: 'cpr, name, email required' });
    }

    const existingMap = await get('SELECT cpr FROM mitid_accounts WHERE cpr = ?', [cpr]);
    if (existingMap) return res.status(409).json({ error: 'cpr exists' });

    const existingUser = await get('SELECT email FROM users WHERE email = ?', [email]);
    if (existingUser) {
      await run('UPDATE users SET name = ? WHERE email = ?', [name, email]);
    } else {
      await run('INSERT INTO users (email, name, password, createdAt) VALUES (?, ?, ?, ?)', [
        email,
        name,
        null,
        nowIso()
      ]);
    }

    await run('INSERT INTO mitid_accounts (cpr, email, createdAt) VALUES (?, ?, ?)', [cpr, email, nowIso()]);
    const user = await get('SELECT email, name, createdAt FROM users WHERE email = ?', [email]);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'mitid register failed' });
  }
});

app.get('/api/users/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const user = await get('SELECT email, name, createdAt FROM users WHERE email = ?', [email]);
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'read failed' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const rows = await all('SELECT email, name, createdAt FROM users ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'users read failed' });
  }
});

app.put('/api/users/:email', async (req, res) => {
  try {
    const oldEmail = normalizeEmail(req.params.email);
    const newEmail = normalizeEmail(req.body?.email) || oldEmail;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });

    const existing = await get('SELECT email FROM users WHERE email = ?', [oldEmail]);
    if (!existing) return res.status(404).json({ error: 'not found' });

    if (newEmail !== oldEmail) {
      const conflict = await get('SELECT email FROM users WHERE email = ?', [newEmail]);
      if (conflict) return res.status(409).json({ error: 'email already exists' });

      await run('BEGIN TRANSACTION');
      await run('UPDATE users SET email = ?, name = ? WHERE email = ?', [newEmail, name, oldEmail]);
      await run('UPDATE avatars SET email = ? WHERE email = ?', [newEmail, oldEmail]);
      await run('UPDATE friends SET email = ? WHERE email = ?', [newEmail, oldEmail]);
      await run('UPDATE friends SET friendEmail = ? WHERE friendEmail = ?', [newEmail, oldEmail]);
      await run('UPDATE requests SET email = ? WHERE email = ?', [newEmail, oldEmail]);
      await run('UPDATE requests SET fromEmail = ? WHERE fromEmail = ?', [newEmail, oldEmail]);
      await run('UPDATE events SET email = ? WHERE email = ?', [newEmail, oldEmail]);
      await run('UPDATE locations SET email = ? WHERE email = ?', [newEmail, oldEmail]);
      await run('COMMIT');
    } else {
      await run('UPDATE users SET name = ? WHERE email = ?', [name, oldEmail]);
    }

    const user = await get('SELECT email, name, createdAt FROM users WHERE email = ?', [newEmail]);
    res.json(user);
  } catch (err) {
    await run('ROLLBACK').catch(() => null);
    res.status(500).json({ error: 'update failed' });
  }
});

app.delete('/api/users/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    await run('BEGIN TRANSACTION');
    await run('DELETE FROM avatars WHERE email = ?', [email]);
    await run('DELETE FROM friends WHERE email = ? OR friendEmail = ?', [email, email]);
    await run('DELETE FROM requests WHERE email = ? OR fromEmail = ?', [email, email]);
    await run('DELETE FROM events WHERE email = ?', [email]);
    await run('DELETE FROM locations WHERE email = ?', [email]);
    await run('DELETE FROM users WHERE email = ?', [email]);
    await run('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await run('ROLLBACK').catch(() => null);
    res.status(500).json({ error: 'delete failed' });
  }
});

app.get('/api/avatar/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const row = await get('SELECT data, updatedAt FROM avatars WHERE email = ?', [email]);
    res.json(row ? { data: JSON.parse(row.data), updatedAt: row.updatedAt } : { data: null });
  } catch (err) {
    res.status(500).json({ error: 'avatar read failed' });
  }
});

app.put('/api/avatar/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const data = req.body?.data;
    if (!data) return res.status(400).json({ error: 'data required' });

    const existing = await get('SELECT email FROM avatars WHERE email = ?', [email]);
    if (existing) {
      await run('UPDATE avatars SET data = ?, updatedAt = ? WHERE email = ?', [JSON.stringify(data), nowIso(), email]);
    } else {
      await run('INSERT INTO avatars (email, data, updatedAt) VALUES (?, ?, ?)', [email, JSON.stringify(data), nowIso()]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'avatar save failed' });
  }
});

app.get('/api/friends/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const rows = await all('SELECT friendEmail FROM friends WHERE email = ?', [email]);
    res.json(rows.map(r => r.friendEmail));
  } catch (err) {
    res.status(500).json({ error: 'friends read failed' });
  }
});

app.post('/api/friends/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const friendEmail = normalizeEmail(req.body?.friendEmail);
    if (!friendEmail) return res.status(400).json({ error: 'friendEmail required' });
    await run('INSERT OR IGNORE INTO friends (email, friendEmail) VALUES (?, ?)', [email, friendEmail]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'friends update failed' });
  }
});

app.delete('/api/friends/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const friendEmail = normalizeEmail(req.query.friendEmail);
    if (!friendEmail) return res.status(400).json({ error: 'friendEmail required' });
    await run('DELETE FROM friends WHERE email = ? AND friendEmail = ?', [email, friendEmail]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'friends delete failed' });
  }
});

app.get('/api/requests/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const rows = await all('SELECT fromEmail FROM requests WHERE email = ?', [email]);
    res.json(rows.map(r => r.fromEmail));
  } catch (err) {
    res.status(500).json({ error: 'requests read failed' });
  }
});

app.post('/api/requests/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const fromEmail = normalizeEmail(req.body?.fromEmail);
    if (!fromEmail) return res.status(400).json({ error: 'fromEmail required' });
    await run('INSERT OR IGNORE INTO requests (email, fromEmail) VALUES (?, ?)', [email, fromEmail]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'requests update failed' });
  }
});

app.delete('/api/requests/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const fromEmail = normalizeEmail(req.query.fromEmail);
    if (!fromEmail) return res.status(400).json({ error: 'fromEmail required' });
    await run('DELETE FROM requests WHERE email = ? AND fromEmail = ?', [email, fromEmail]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'requests delete failed' });
  }
});

app.get('/api/events/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const type = String(req.query.type || '').trim();
    if (!type) return res.status(400).json({ error: 'type required' });

    await pruneEvents(email);
    const rows = await all(
      'SELECT eventId, type, name, city, date, rawDate, url FROM events WHERE email = ? AND type = ? ORDER BY rawDate ASC',
      [email, type]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'events read failed' });
  }
});

app.post('/api/events/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const type = String(req.body?.type || '').trim();
    const event = req.body?.event || {};
    if (!type || !event.eventId || !event.name) {
      return res.status(400).json({ error: 'type, eventId, name required' });
    }
    await run(
      'INSERT OR REPLACE INTO events (email, eventId, type, name, city, date, rawDate, url, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        email,
        event.eventId,
        type,
        event.name,
        event.city || '',
        event.date || '',
        event.rawDate || '',
        event.url || '',
        nowIso()
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'events save failed' });
  }
});

app.delete('/api/events/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const type = String(req.query.type || '').trim();
    const eventId = String(req.query.eventId || '').trim();
    if (!type || !eventId) return res.status(400).json({ error: 'type and eventId required' });
    await run('DELETE FROM events WHERE email = ? AND type = ? AND eventId = ?', [email, type, eventId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'events delete failed' });
  }
});

app.get('/api/locations', async (req, res) => {
  try {
    const rows = await all('SELECT email, lat, lng, updatedAt FROM locations');
    const map = {};
    rows.forEach(row => {
      map[row.email] = {
        lat: row.lat,
        lng: row.lng,
        updatedAt: row.updatedAt
      };
    });
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: 'locations read failed' });
  }
});

app.post('/api/locations/:email', async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const updatedAt = Number(req.body?.updatedAt || Date.now());
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng required' });
    }
    await run(
      'INSERT OR REPLACE INTO locations (email, lat, lng, updatedAt) VALUES (?, ?, ?, ?)',
      [email, lat, lng, updatedAt]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'locations update failed' });
  }
});

const port = Number(process.env.PORT || 3002);

init()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch(err => {
    console.error('Failed to init db', err);
    process.exit(1);
  });
