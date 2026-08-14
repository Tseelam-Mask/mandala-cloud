const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));
app.options('*', cors());

// ── Database ───────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      lang TEXT DEFAULT 'en',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS dreams (
      id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      date TEXT,
      stages JSONB DEFAULT '{}',
      symbol TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      email TEXT,
      text TEXT NOT NULL,
      page TEXT,
      stage TEXT,
      lang TEXT DEFAULT 'en',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database ready');
}

// ── Auth helpers ───────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'mandala-change-this-secret';

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired — please log in again' });
  }
}

// ── Rate limiting ──────────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 });
const apiLimiter = rateLimit({ windowMs: 60*1000, max: 30 });

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'alive',
  hasKey: !!process.env.ANTHROPIC_API_KEY,
  time: new Date().toISOString()
}));

// ── Signup ─────────────────────────────────────────────────────────────────────
app.post('/auth/signup', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email.toLowerCase().trim(), hash]
    );
    const user = result.rows[0];
    res.json({ token: signToken(user.id), email: user.email });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
    console.error(e);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// ── Login ──────────────────────────────────────────────────────────────────────
app.post('/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    res.json({ token: signToken(user.id), email: user.email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Get dreams ─────────────────────────────────────────────────────────────────
app.get('/dreams', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, title, date, stages, symbol FROM dreams WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load dreams' });
  }
});

// ── Save dream ─────────────────────────────────────────────────────────────────
app.put('/dreams/:id', authMiddleware, apiLimiter, async (req, res) => {
  const { title, date, stages, symbol } = req.body;
  try {
    await db.query(`
      INSERT INTO dreams (id, user_id, title, date, stages, symbol, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id, user_id) DO UPDATE SET
        title = EXCLUDED.title, date = EXCLUDED.date,
        stages = EXCLUDED.stages, symbol = EXCLUDED.symbol, updated_at = NOW()
    `, [req.params.id, req.userId, title, date, JSON.stringify(stages), symbol || null]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save dream' });
  }
});

// ── Feedback ───────────────────────────────────────────────────────────────────
app.post('/feedback', async (req, res) => {
  const { text, email, page, stage } = req.body;
  if (!text) return res.status(400).json({ error: 'Feedback text required' });
  try {
    await db.query(
      'INSERT INTO feedback (email, text, page, stage) VALUES ($1, $2, $3, $4)',
      [email || null, text, page || null, stage || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// ── Admin feedback view (password protected) ────────────────────────────────
app.get('/admin/feedback', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await db.query('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ── User language preference ──────────────────────────────────────────────────
app.put('/user/lang', authMiddleware, async (req, res) => {
  const { lang } = req.body;
  try {
    await db.query('UPDATE users SET lang = $1 WHERE id = $2', [lang, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ── Claude proxy (requires auth) ───────────────────────────────────────────────
app.post('/api/dream', authMiddleware, apiLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'API error' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Proxy error: ' + e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log('Mandala Cloud running on port ' + PORT));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
