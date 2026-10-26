const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { router: ephemerisRouter } = require('./ephemeris');

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
      birth_date TEXT,
      birth_time TEXT,
      birth_lat DOUBLE PRECISION,
      birth_lon DOUBLE PRECISION,
      birth_place TEXT,
      natal_chart JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- migrate existing users table if columns missing
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='birth_date') THEN
        ALTER TABLE users ADD COLUMN birth_date TEXT;
        ALTER TABLE users ADD COLUMN birth_time TEXT;
        ALTER TABLE users ADD COLUMN birth_lat DOUBLE PRECISION;
        ALTER TABLE users ADD COLUMN birth_lon DOUBLE PRECISION;
        ALTER TABLE users ADD COLUMN birth_place TEXT;
        ALTER TABLE users ADD COLUMN natal_chart JSONB;
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS dreams (
      id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      date TEXT,
      stages JSONB DEFAULT '{}',
      symbol TEXT,
      sky_snapshot JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, user_id)
    );
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dreams' AND column_name='sky_snapshot') THEN
        ALTER TABLE dreams ADD COLUMN sky_snapshot JSONB;
      END IF;
    END $$;
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
const guestLimiter = rateLimit({ windowMs: 60*60*1000, max: 20, message: {error:'Guest limit reached — sign in for unlimited access'} });

// ── Health ─────────────────────────────────────────────────────────────────────
const path = require('path');

// ── Admin HTML page ────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/health', (req, res) => res.json({
  status: 'alive',
  hasKey: !!process.env.ANTHROPIC_API_KEY,
  time: new Date().toISOString()
}));

// ── Ephemeris ──────────────────────────────────────────────────────────────────
app.use('/api/ephemeris', ephemerisRouter);

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

// ── Save dream (with optional sky snapshot) ────────────────────────────────────
app.put('/dreams/:id', authMiddleware, apiLimiter, async (req, res) => {
  const { title, date, stages, symbol, sky_snapshot } = req.body;
  try {
    await db.query(`
      INSERT INTO dreams (id, user_id, title, date, stages, symbol, sky_snapshot, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (id, user_id) DO UPDATE SET
        title = EXCLUDED.title, date = EXCLUDED.date,
        stages = EXCLUDED.stages, symbol = EXCLUDED.symbol,
        sky_snapshot = COALESCE(EXCLUDED.sky_snapshot, dreams.sky_snapshot),
        updated_at = NOW()
    `, [req.params.id, req.userId, title, date, JSON.stringify(stages),
        symbol || null, sky_snapshot ? JSON.stringify(sky_snapshot) : null]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save dream' });
  }
});

// ── AstroRead: retroactively populate sky snapshots for all dreams ─────────────
app.post('/api/astroread/populate', authMiddleware, async (req, res) => {
  try {
    const { buildSkySnapshot } = require('./ephemeris');
    const rows = await db.query(
      'SELECT id, created_at FROM dreams WHERE user_id=$1 AND sky_snapshot IS NULL',
      [req.userId]
    );
    let populated = 0;
    for (const row of rows.rows) {
      try {
        const snap = buildSkySnapshot(row.created_at.toISOString());
        await db.query(
          'UPDATE dreams SET sky_snapshot=$1 WHERE id=$2 AND user_id=$3',
          [JSON.stringify(snap), row.id, req.userId]
        );
        populated++;
      } catch(e) { /* skip individual failures */ }
    }
    res.json({ success: true, populated, total: rows.rows.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AstroRead: longitudinal correlation summary ────────────────────────────────
app.get('/api/astroread/summary', authMiddleware, async (req, res) => {
  try {
    const dreamRows = await db.query(
      `SELECT id, title, date, stages, symbol, sky_snapshot, created_at
       FROM dreams WHERE user_id=$1 AND sky_snapshot IS NOT NULL ORDER BY created_at ASC`,
      [req.userId]
    );
    const userRow = await db.query(
      'SELECT natal_chart FROM users WHERE id=$1', [req.userId]
    );
    const natalChart = userRow.rows[0]?.natal_chart || null;
    const dreams = dreamRows.rows;

    // Distributions
    const moonDist = {}, sunDist = {};
    const mercRetro = { retro: 0, direct: 0 };
    const venusRetro = { retro: 0, direct: 0 };
    const lunarPhases = { new: 0, waxing: 0, full: 0, waning: 0 };

    const entries = dreams.map(d => {
      const snap = d.sky_snapshot;
      if (!snap || !snap.planets) return null;
      const p = snap.planets;
      const moonSign = p.moon?.sign, sunSign = p.sun?.sign;
      if (moonSign) moonDist[moonSign] = (moonDist[moonSign]||0)+1;
      if (sunSign)  sunDist[sunSign]   = (sunDist[sunSign]||0)+1;
      if (p.mercury?.retrograde) mercRetro.retro++; else mercRetro.direct++;
      if (p.venus?.retrograde)   venusRetro.retro++; else venusRetro.direct++;
      const sunLon = p.sun?.longitude||0, moonLon = p.moon?.longitude||0;
      const angle  = ((moonLon - sunLon) + 360) % 360;
      if (angle < 45 || angle >= 315)   lunarPhases.new++;
      else if (angle < 135)             lunarPhases.waxing++;
      else if (angle < 225)             lunarPhases.full++;
      else                              lunarPhases.waning++;
      return {
        id: d.id, title: d.title, date: d.date, created_at: d.created_at,
        moonSign, sunSign,
        mercury_retro: p.mercury?.retrograde, venus_retro: p.venus?.retrograde,
        saturn_sign: p.saturn?.sign, north_node_sign: p.northNode?.sign,
        sun_lon: sunLon, moon_lon: moonLon, symbol: d.symbol,
        has_journal: !!(d.stages?.journal),
        journal_excerpt: d.stages?.journal ? d.stages.journal.slice(0,120) : null,
      };
    }).filter(Boolean);

    // Natal correlations
    let natalCorrelations = null;
    if (natalChart && natalChart.planets) {
      const np = natalChart.planets;
      const natalMoon = np.moon?.sign, natalSun = np.sun?.sign, natalAsc = natalChart.ascendantSign;
      natalCorrelations = {
        natalMoon, natalSun, natalAsc,
        entriesUnderNatalMoonSign: entries.filter(e=>e.moonSign===natalMoon).length,
        entriesUnderNatalSunSign:  entries.filter(e=>e.sunSign===natalSun).length,
        entriesWhileMoonInAsc:     entries.filter(e=>e.moonSign===natalAsc).length,
      };
    }

    res.json({
      success: true,
      totalEntries: entries.length,
      moonDistribution: Object.entries(moonDist).sort((a,b)=>b[1]-a[1]),
      sunDistribution:  Object.entries(sunDist).sort((a,b)=>b[1]-a[1]),
      mercuryRetrograde: mercRetro,
      venusRetrograde: venusRetro,
      lunarPhases,
      natalCorrelations,
      entries,
    });
  } catch(e) {
    console.error('AstroRead error:', e);
    res.status(500).json({ error: e.message });
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

// ── Birth profile ─────────────────────────────────────────────────────────────
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT birth_date, birth_time, birth_lat, birth_lon, birth_place, natal_chart FROM users WHERE id = $1',
      [req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, profile: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/user/profile', authMiddleware, async (req, res) => {
  const { birth_date, birth_time, birth_lat, birth_lon, birth_place } = req.body;
  if (!birth_date) return res.status(400).json({ error: 'birth_date required' });
  try {
    // Compute natal chart via internal ephemeris
    const birthISO = birth_time
      ? `${birth_date}T${birth_time}:00.000Z`
      : `${birth_date}T12:00:00.000Z`;
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${process.env.PORT || 3000}`;
    const natalRes = await fetch(`${baseUrl}/api/ephemeris/natal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        birthDate: birthISO,
        birthLat: parseFloat(birth_lat) || 0,
        birthLon: parseFloat(birth_lon) || 0,
      })
    });
    const natalData = await natalRes.json();
    const natal_chart = natalData.success ? natalData.natalChart : null;
    await db.query(
      `UPDATE users SET birth_date=$1, birth_time=$2, birth_lat=$3, birth_lon=$4,
       birth_place=$5, natal_chart=$6 WHERE id=$7`,
      [birth_date, birth_time || null, parseFloat(birth_lat) || null,
       parseFloat(birth_lon) || null, birth_place || null,
       natal_chart ? JSON.stringify(natal_chart) : null, req.userId]
    );
    res.json({ success: true, natal_chart });
  } catch (e) {
    console.error('Profile update error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Claude proxy (requires auth) ───────────────────────────────────────────────
app.post('/api/dream', apiLimiter, async (req, res) => {
  // Optional auth — guests can use basic analysis without signing in
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET);
      req.userId = payload.userId;
    } catch(e) {
      return res.status(401).json({ error: 'Session expired — please log in again' });
    }
  }
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


// ── Keep-alive ping (prevents Railway cold start delays) ──────────────────────
const SELF_URL = 'https://mandala-cloud-production.up.railway.app/health';
setInterval(async () => {
  try { await fetch(SELF_URL); console.log('ping ok'); } catch (e) {}
}, 3 * 60 * 1000); // every 3 minutes

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log('Mandala Cloud running on port ' + PORT));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
