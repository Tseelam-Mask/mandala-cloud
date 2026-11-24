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
    -- Symbols extracted from memoryRecord per entry
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dreams' AND column_name='symbols') THEN
        ALTER TABLE dreams ADD COLUMN symbols JSONB;
      END IF;
    END $$;
    -- Cross-entry symbol index
    CREATE TABLE IF NOT EXISTS symbol_index (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      entry_type TEXT DEFAULT 'dream',
      symbol TEXT NOT NULL,
      symbol_type TEXT DEFAULT 'symbol',
      archetype TEXT,
      alchemical TEXT,
      moon_sign TEXT,
      sun_sign TEXT,
      mercury_retro BOOLEAN DEFAULT FALSE,
      venus_retro BOOLEAN DEFAULT FALSE,
      lunar_phase TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, entry_id, symbol)
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
    -- Map Reading sessions (Jung / subconscious map analytic sessions)
    CREATE TABLE IF NOT EXISTS map_reading_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT,
      conversation JSONB NOT NULL DEFAULT '[]',
      record JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Analyst accounts (separate from patient users)
    CREATE TABLE IF NOT EXISTS analyst_accounts (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Analyst ↔ patient links
    CREATE TABLE IF NOT EXISTS analyst_patient_links (
      id SERIAL PRIMARY KEY,
      analyst_id INTEGER REFERENCES analyst_accounts(id) ON DELETE CASCADE,
      patient_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      invite_token TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'pending',  -- pending | active | revoked
      patient_consented_at TIMESTAMPTZ,
      analyst_note TEXT,
      analyst_note_consumed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(analyst_id, patient_user_id)
    );
    -- Patient consent flag on users table
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='analyst_consent') THEN
        ALTER TABLE users ADD COLUMN analyst_consent BOOLEAN DEFAULT FALSE;
      END IF;
    END $$;
    -- Stored clinical briefs (archived, never regenerated unless requested)
    CREATE TABLE IF NOT EXISTS clinical_briefs (
      id SERIAL PRIMARY KEY,
      patient_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      brief_text TEXT NOT NULL,
      entry_count INTEGER,
      generated_by TEXT DEFAULT 'patient',  -- 'patient' | 'analyst'
      generated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Clinical analysis JSON (Prompt One output — pattern extraction)
    CREATE TABLE IF NOT EXISTS clinical_analysis (
      id SERIAL PRIMARY KEY,
      patient_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      analysis_json JSONB NOT NULL,
      entry_count INTEGER,
      generated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Add analysis_json column to clinical_briefs if not present
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clinical_briefs' AND column_name='analysis_json') THEN
        ALTER TABLE clinical_briefs ADD COLUMN analysis_json JSONB;
      END IF;
    END $$;
    -- Add from_date column to clinical_briefs (date range filter used when generating)
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clinical_briefs' AND column_name='from_date') THEN
        ALTER TABLE clinical_briefs ADD COLUMN from_date DATE;
      END IF;
    END $$;
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
  const { title, date, stages, symbol, sky_snapshot, symbols } = req.body;
  try {
    await db.query(`
      INSERT INTO dreams (id, user_id, title, date, stages, symbol, sky_snapshot, symbols, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (id, user_id) DO UPDATE SET
        title = EXCLUDED.title, date = EXCLUDED.date,
        stages = EXCLUDED.stages, symbol = EXCLUDED.symbol,
        sky_snapshot = COALESCE(EXCLUDED.sky_snapshot, dreams.sky_snapshot),
        symbols = COALESCE(EXCLUDED.symbols, dreams.symbols),
        updated_at = NOW()
    `, [req.params.id, req.userId, title, date, JSON.stringify(stages),
        symbol || null, sky_snapshot ? JSON.stringify(sky_snapshot) : null,
        symbols ? JSON.stringify(symbols) : null]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save dream' });
  }
});

// ── Delete dream + clean up symbol_index ──────────────────────────────────────
app.delete('/dreams/:id', authMiddleware, apiLimiter, async (req, res) => {
  const entryId = req.params.id;
  try {
    // Remove symbol memory footprint first (so longitudinal brief recomputes cleanly)
    await db.query(
      'DELETE FROM symbol_index WHERE entry_id=$1 AND user_id=$2',
      [entryId, req.userId]
    );
    // Then delete the dream itself
    const result = await db.query(
      'DELETE FROM dreams WHERE id=$1 AND user_id=$2',
      [entryId, req.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete entry' });
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
    // Per-entry-type moon distributions
    const moonByType = {}; // { dream: {Scorpio:3,...}, sign: {...}, ... }
    const typeCounts = {};

    const entries = dreams.map(d => {
      const snap = d.sky_snapshot;
      if (!snap || !snap.planets) return null;
      const p = snap.planets;
      // Infer entry type from stages JSONB
      const st = d.stages || {};
      const entryType = st.entryType || d.symbol?.split(':')[0] || 'dream';
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
      // Per-type breakdowns
      if (!moonByType[entryType]) moonByType[entryType] = {};
      if (moonSign) moonByType[entryType][moonSign] = (moonByType[entryType][moonSign]||0)+1;
      typeCounts[entryType] = (typeCounts[entryType]||0)+1;
      return {
        id: d.id, title: d.title, date: d.date, created_at: d.created_at,
        entryType, moonSign, sunSign,
        mercury_retro: p.mercury?.retrograde, venus_retro: p.venus?.retrograde,
        saturn_sign: p.saturn?.sign, north_node_sign: p.northNode?.sign,
        sun_lon: sunLon, moon_lon: moonLon, symbol: d.symbol,
        has_journal: !!(st.journal),
        journal_excerpt: st.journal ? st.journal.slice(0,120) : null,
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

    // Sort per-type moon distributions
    const moonByTypeSorted = {};
    for (const [type, dist] of Object.entries(moonByType)) {
      moonByTypeSorted[type] = Object.entries(dist).sort((a,b)=>b[1]-a[1]);
    }

    res.json({
      success: true,
      totalEntries: entries.length,
      typeCounts,
      moonDistribution: Object.entries(moonDist).sort((a,b)=>b[1]-a[1]),
      sunDistribution:  Object.entries(sunDist).sort((a,b)=>b[1]-a[1]),
      moonByType: moonByTypeSorted,
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

// ── Symbol extraction helper ───────────────────────────────────────────────────
async function extractSymbols(memoryRecord, entryType, apiKey) {
  if (!memoryRecord || !apiKey) return null;
  const text = typeof memoryRecord === 'string' ? memoryRecord : JSON.stringify(memoryRecord);
  if (text.length < 30) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        system: `You extract Jungian symbolic content from dream/psyche journal entries. Return ONLY valid JSON, no prose.`,
        messages: [{
          role: 'user',
          content: `Extract the core symbolic content from this ${entryType} entry record. Return JSON with these fields:
{
  "archetypes": ["shadow","anima","self","persona","animus","trickster","wise_old_man","great_mother","hero","child","other"],
  "symbols": ["list of concrete symbols: water, serpent, tower, fire, mirror, etc — max 8, only what actually appears"],
  "figures": ["named or described figures that appear: mother, stranger, king, etc — max 5"],
  "alchemical": "nigredo|albedo|citrinitas|rubedo|unknown",
  "emotionalRegister": "one phrase: numinous dread, ecstatic expansion, etc",
  "threshold": true/false
}

Entry record: ${text.slice(0, 800)}`
        }]
      })
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch(e) {
    console.error('Symbol extraction error:', e.message);
    return null;
  }
}

// ── Index a single entry's symbols into symbol_index ──────────────────────────
async function indexEntrySymbols(userId, entry, symbols) {
  if (!symbols) return;
  const snap = entry.sky_snapshot;
  const p = snap?.planets || {};
  const moonSign = p.moon?.sign || null;
  const sunSign = p.sun?.sign || null;
  const mercRetro = p.mercury?.retrograde || false;
  const venusRetro = p.venus?.retrograde || false;
  const sunLon = p.sun?.longitude || 0;
  const moonLon = p.moon?.longitude || 0;
  const angle = ((moonLon - sunLon) + 360) % 360;
  const lunarPhase = angle < 45 || angle >= 315 ? 'new'
    : angle < 135 ? 'waxing' : angle < 225 ? 'full' : 'waning';
  const st = entry.stages || {};
  const entryType = st.entryType || entry.symbol?.split(':')[0] || 'dream';
  const alchemical = symbols.alchemical || null;

  const allSymbols = [
    ...(symbols.symbols || []).map(s => ({ s, type: 'symbol' })),
    ...(symbols.archetypes || []).map(s => ({ s, type: 'archetype' })),
    ...(symbols.figures || []).map(s => ({ s, type: 'figure' })),
  ];

  for (const { s, type } of allSymbols) {
    if (!s || s.length < 2) continue;
    try {
      await db.query(`
        INSERT INTO symbol_index
          (user_id, entry_id, entry_type, symbol, symbol_type, archetype, alchemical,
           moon_sign, sun_sign, mercury_retro, venus_retro, lunar_phase, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (user_id, entry_id, symbol) DO NOTHING
      `, [userId, entry.id, entryType, s.toLowerCase(), type,
          type === 'archetype' ? s.toLowerCase() : null,
          alchemical, moonSign, sunSign, mercRetro, venusRetro, lunarPhase,
          entry.created_at]);
    } catch(e) { /* skip dup */ }
  }
}

// ── POST /api/symbols/extract — extract + store symbols for one entry ──────────
app.post('/api/symbols/extract', authMiddleware, async (req, res) => {
  const { entryId } = req.body;
  if (!entryId) return res.status(400).json({ error: 'entryId required' });
  try {
    const row = await db.query(
      'SELECT * FROM dreams WHERE id=$1 AND user_id=$2', [entryId, req.userId]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Entry not found' });
    const entry = row.rows[0];
    const st = entry.stages || {};
    const memRec = st.memoryRecord || st.journal || st.reflection || '';
    const entryType = st.entryType || 'dream';
    const symbols = await extractSymbols(memRec, entryType, process.env.ANTHROPIC_API_KEY);
    if (symbols) {
      await db.query('UPDATE dreams SET symbols=$1 WHERE id=$2 AND user_id=$3',
        [JSON.stringify(symbols), entryId, req.userId]);
      await indexEntrySymbols(req.userId, entry, symbols);
    }
    res.json({ success: true, symbols });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/symbols/populate — retroactively extract all entries ─────────────
app.post('/api/symbols/populate', authMiddleware, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key' });
  try {
    const rows = await db.query(
      'SELECT * FROM dreams WHERE user_id=$1 AND symbols IS NULL ORDER BY created_at ASC',
      [req.userId]
    );
    let processed = 0, failed = 0;
    for (const entry of rows.rows) {
      try {
        const st = entry.stages || {};
        const memRec = st.memoryRecord || st.journal || st.reflection || '';
        const entryType = st.entryType || 'dream';
        const symbols = await extractSymbols(memRec, entryType, apiKey);
        if (symbols) {
          await db.query('UPDATE dreams SET symbols=$1 WHERE id=$2 AND user_id=$3',
            [JSON.stringify(symbols), entry.id, req.userId]);
          await indexEntrySymbols(req.userId, entry, symbols);
          processed++;
        }
        // Rate limit: 2 per second (haiku is fast)
        await new Promise(r => setTimeout(r, 500));
      } catch(e) { failed++; }
    }
    res.json({ success: true, processed, failed, total: rows.rows.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/symbols/reindex — rebuild symbol_index from existing symbols ─────
app.post('/api/symbols/reindex', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM symbol_index WHERE user_id=$1', [req.userId]);
    const rows = await db.query(
      'SELECT * FROM dreams WHERE user_id=$1 AND symbols IS NOT NULL', [req.userId]
    );
    let indexed = 0;
    for (const entry of rows.rows) {
      await indexEntrySymbols(req.userId, entry, entry.symbols);
      indexed++;
    }
    res.json({ success: true, indexed });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/longitudinal/brief — living cross-entry brief for Oracle ──────────
app.get('/api/longitudinal/brief', authMiddleware, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Symbol frequency + sky correlations from symbol_index
    const symRows = await db.query(`
      SELECT symbol, symbol_type, archetype, alchemical,
             COUNT(*) as count,
             COUNT(*) FILTER (WHERE mercury_retro = TRUE) as mercury_retro_count,
             COUNT(*) FILTER (WHERE venus_retro = TRUE) as venus_retro_count,
             MODE() WITHIN GROUP (ORDER BY moon_sign) as top_moon_sign,
             MODE() WITHIN GROUP (ORDER BY lunar_phase) as top_phase,
             MODE() WITHIN GROUP (ORDER BY entry_type) as top_entry_type
      FROM symbol_index
      WHERE user_id=$1 AND created_at >= $2
      GROUP BY symbol, symbol_type, archetype, alchemical
      ORDER BY count DESC
      LIMIT 30
    `, [req.userId, since]);

    // Entry counts per type + alchemical stage
    const entryRows = await db.query(`
      SELECT
        stages->>'entryType' as entry_type,
        symbols->>'alchemical' as alchemical,
        COUNT(*) as count
      FROM dreams
      WHERE user_id=$1 AND created_at >= $2
      GROUP BY entry_type, alchemical
      ORDER BY count DESC
    `, [req.userId, since]);

    // Alchemical arc: earliest third vs recent third
    const allRows = await db.query(`
      SELECT symbols->>'alchemical' as alchemical, created_at
      FROM dreams WHERE user_id=$1 AND symbols IS NOT NULL
      ORDER BY created_at ASC
    `, [req.userId]);
    const all = allRows.rows.filter(r => r.alchemical && r.alchemical !== 'unknown');
    const third = Math.max(1, Math.floor(all.length / 3));
    const earliest = all.slice(0, third).map(r => r.alchemical);
    const recent   = all.slice(-third).map(r => r.alchemical);
    const mode = arr => {
      const m = {}; arr.forEach(v => m[v]=(m[v]||0)+1);
      return Object.entries(m).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;
    };

    // Archetype evolution: first appearance vs most recent
    const archetypeRows = await db.query(`
      SELECT symbol, MIN(created_at) as first_seen, MAX(created_at) as last_seen, COUNT(*) as count
      FROM symbol_index
      WHERE user_id=$1 AND symbol_type='archetype' AND created_at >= $2
      GROUP BY symbol ORDER BY count DESC LIMIT 8
    `, [req.userId, since]);

    // Moon sign productivity
    const moonProdRows = await db.query(`
      SELECT moon_sign, COUNT(*) as count,
             COUNT(DISTINCT entry_id) as entries
      FROM symbol_index
      WHERE user_id=$1 AND created_at >= $2 AND moon_sign IS NOT NULL
      GROUP BY moon_sign ORDER BY entries DESC LIMIT 5
    `, [req.userId, since]);

    const recurringSymbols = symRows.rows.filter(r => r.count >= 2).map(r => ({
      symbol: r.symbol,
      type: r.symbol_type,
      count: parseInt(r.count),
      topMoonSign: r.top_moon_sign,
      topPhase: r.top_phase,
      topEntryType: r.top_entry_type,
      mercuryRetroCount: parseInt(r.mercury_retro_count),
      alchemical: r.alchemical,
    }));

    // Last pattern reading — most recent session with a record
    const prRow = await db.query(
      `SELECT record, updated_at FROM map_reading_sessions
       WHERE user_id=$1 AND record IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
      [req.userId]
    );
    let lastPatternReading = null;
    if (prRow.rows.length) {
      const rec = prRow.rows[0].record;
      lastPatternReading = {
        date: prRow.rows[0].updated_at,
        whatWasNamed: rec.what_was_named || null,
        dreamerInsight: rec.dreamer_insight || null,
        openQuestions: rec.open_questions || [],
        alchemicalStage: rec.alchemical_stage_observed || null,
        archetypalMovement: rec.archetypal_movement || null,
      };
    }

    res.json({
      success: true,
      period: `${days} days`,
      recurringSymbols,
      alchemicalArc: {
        earliest: mode(earliest),
        recent: mode(recent),
        direction: earliest.length && recent.length
          ? `${mode(earliest)} → ${mode(recent)}` : null,
        totalMapped: all.length,
      },
      archetypes: archetypeRows.rows.map(r => ({
        name: r.symbol,
        count: parseInt(r.count),
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
      })),
      moonProductivity: moonProdRows.rows.map(r => ({
        moonSign: r.moon_sign, entries: parseInt(r.entries), symbols: parseInt(r.count)
      })),
      entryBreakdown: entryRows.rows,
      lastPatternReading,
    });
  } catch(e) {
    console.error('Longitudinal brief error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/symbols/for-entry/:id — return symbols for one entry ──────────────
app.get('/api/symbols/for-entry/:id', authMiddleware, async (req, res) => {
  try {
    const row = await db.query(
      'SELECT symbols FROM dreams WHERE id=$1 AND user_id=$2',
      [req.params.id, req.userId]
    );
    res.json({ success: true, symbols: row.rows[0]?.symbols || null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/symbols/timeline — symbol appearances over time ───────────────────
app.get('/api/symbols/timeline', authMiddleware, async (req, res) => {
  const { symbol } = req.query;
  try {
    const rows = await db.query(`
      SELECT si.entry_id, si.symbol, si.symbol_type, si.moon_sign, si.lunar_phase,
             si.mercury_retro, si.alchemical, si.created_at, si.entry_type,
             d.title, d.stages->>'memoryRecord' as memory_excerpt
      FROM symbol_index si
      JOIN dreams d ON d.id = si.entry_id AND d.user_id = si.user_id
      WHERE si.user_id=$1 ${symbol ? 'AND si.symbol=$2' : ''}
      ORDER BY si.created_at ASC
      LIMIT 200
    `, symbol ? [req.userId, symbol.toLowerCase()] : [req.userId]);
    res.json({ success: true, timeline: rows.rows });
  } catch(e) {
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
    // Inject analyst note into system prompt if one exists for this patient
    let payload = req.body;
    if (req.userId && payload.system) {
      try {
        const noteRow = await db.query(
          `SELECT apl.id, apl.analyst_note, aa.name AS analyst_name
           FROM analyst_patient_links apl
           JOIN analyst_accounts aa ON aa.id = apl.analyst_id
           WHERE apl.patient_user_id = $1 AND apl.status = 'active'
             AND apl.analyst_note IS NOT NULL AND apl.analyst_note_consumed = FALSE
           ORDER BY apl.updated_at DESC LIMIT 1`,
          [req.userId]
        );
        if (noteRow.rows.length) {
          const { id: linkId, analyst_note, analyst_name } = noteRow.rows[0];
          const analystLayer = `\n\n[ANALYST CONTEXT — for Oracle awareness only, not to be quoted or attributed directly]\nThe patient's analyst (${analyst_name || 'their analyst'}) has left the following observation:\n"${analyst_note}"\nHold this as background clinical context. Do not reference the analyst explicitly. Let it inform your attunement to what is alive in this session.`;
          payload = { ...payload, system: payload.system + analystLayer };
          // Mark note consumed after it enters the session
          await db.query(
            `UPDATE analyst_patient_links SET analyst_note_consumed = TRUE, updated_at = NOW() WHERE id = $1`,
            [linkId]
          );
        }
      } catch(noteErr) {
        console.error('Analyst note injection error (non-fatal):', noteErr.message);
        // Continue without note — never block the session
      }
    }

    // Convert system string → cached content block so Anthropic caches the
    // system prompt prefix (saves 90% on input tokens for turns 2+)
    if (payload.system && typeof payload.system === 'string') {
      payload = {
        ...payload,
        system: [{ type: 'text', text: payload.system, cache_control: { type: 'ephemeral' } }]
      };
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(payload),
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

// ── Map Reading Sessions ───────────────────────────────────────────────────────

// Index symbols_discussed from a pattern reading record into symbol_index
// Uses a stable pseudo entry_id so re-saves don't duplicate
async function indexPatternReadingSymbols(userId, sessionId, record, sessionCreatedAt) {
  if (!record || !record.symbols_discussed || !record.symbols_discussed.length) return;
  const pseudoEntryId = `pr_${sessionId}`;
  const alchemical = record.alchemical_stage_observed || null;
  const createdAt = sessionCreatedAt || new Date().toISOString();

  // Remove old rows for this session so a re-save replaces cleanly
  await db.query(
    `DELETE FROM symbol_index WHERE user_id=$1 AND entry_id=$2`,
    [userId, pseudoEntryId]
  );

  for (const sym of record.symbols_discussed) {
    if (!sym || sym.length < 2) continue;
    try {
      await db.query(`
        INSERT INTO symbol_index
          (user_id, entry_id, entry_type, symbol, symbol_type, archetype, alchemical,
           moon_sign, sun_sign, mercury_retro, venus_retro, lunar_phase, created_at)
        VALUES ($1,$2,'pattern_reading',$3,'symbol',NULL,$4,
                NULL,NULL,FALSE,FALSE,'unknown',$5)
        ON CONFLICT (user_id, entry_id, symbol) DO UPDATE SET alchemical=EXCLUDED.alchemical
      `, [userId, pseudoEntryId, sym.toLowerCase(), alchemical, createdAt]);
    } catch(e) { /* skip */ }
  }
  // Also index key_themes as symbols with type 'theme'
  for (const theme of (record.key_themes || [])) {
    if (!theme || theme.length < 2) continue;
    try {
      await db.query(`
        INSERT INTO symbol_index
          (user_id, entry_id, entry_type, symbol, symbol_type, archetype, alchemical,
           moon_sign, sun_sign, mercury_retro, venus_retro, lunar_phase, created_at)
        VALUES ($1,$2,'pattern_reading',$3,'theme',NULL,$4,
                NULL,NULL,FALSE,FALSE,'unknown',$5)
        ON CONFLICT (user_id, entry_id, symbol) DO NOTHING
      `, [userId, pseudoEntryId, theme.toLowerCase(), alchemical, createdAt]);
    } catch(e) { /* skip */ }
  }
}

// GET /api/map-sessions — list all sessions for user (newest first)
app.get('/api/map-sessions', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, title, record, created_at, updated_at,
              jsonb_array_length(conversation) as turn_count
       FROM map_reading_sessions WHERE user_id=$1
       ORDER BY updated_at DESC`,
      [req.userId]
    );
    res.json({ success: true, sessions: result.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/map-sessions — save current conversation as a new session
app.post('/api/map-sessions', authMiddleware, async (req, res) => {
  const { title, conversation, record } = req.body;
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return res.status(400).json({ error: 'conversation required' });
  }
  try {
    const result = await db.query(
      `INSERT INTO map_reading_sessions (user_id, title, conversation, record)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [req.userId, title || null, JSON.stringify(conversation), record ? JSON.stringify(record) : null]
    );
    const session = result.rows[0];
    // Index symbols into longitudinal memory
    if (record) {
      indexPatternReadingSymbols(req.userId, session.id, record, session.created_at).catch(e =>
        console.warn('Pattern reading symbol index failed:', e.message)
      );
    }
    res.json({ success: true, session });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/map-sessions/:id — update conversation + record + title
app.put('/api/map-sessions/:id', authMiddleware, async (req, res) => {
  const { title, conversation, record } = req.body;
  try {
    const result = await db.query(
      `UPDATE map_reading_sessions
       SET title=$1, conversation=$2, record=$3, updated_at=NOW()
       WHERE id=$4 AND user_id=$5 RETURNING id, created_at`,
      [title || null, JSON.stringify(conversation || []),
       record ? JSON.stringify(record) : null,
       req.params.id, req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Session not found' });
    // Re-index symbols whenever record is updated (replaces old rows for this session)
    if (record) {
      const sess = result.rows[0];
      indexPatternReadingSymbols(req.userId, sess.id, record, sess.created_at).catch(e =>
        console.warn('Pattern reading symbol index update failed:', e.message)
      );
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/map-sessions/:id — load full conversation for a session
app.get('/api/map-sessions/:id', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, title, conversation, record, created_at, updated_at
       FROM map_reading_sessions WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true, session: result.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/map-sessions/:id — delete a session
app.delete('/api/map-sessions/:id', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM map_reading_sessions WHERE id=$1 AND user_id=$2`,
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Clinical Intelligence Layer helpers ───────────────────────────────────────

/**
 * Gather all patient data needed for clinical analysis.
 * Returns { alchRows, somaticRows, figuresRows, questionsRows, symbolRows, entryCount }
 */
async function gatherPatientClinicalData(userId, fromDate = null) {
  const params = [userId];
  const dateClause = fromDate ? `AND created_at >= $2::date` : '';
  if (fromDate) params.push(fromDate);

  const alchRows = await db.query(
    `SELECT id, date, title,
            stages->'memoryRecord' AS memory_record,
            stages->'memoryRecord'->'alchemical_territory' AS alch,
            stages->'memoryRecord'->'individuation_marker' AS individuation,
            stages->'memoryRecord'->'images' AS images,
            stages->'memoryRecord'->'figures' AS figures,
            stages->'memoryRecord'->>'somatic_summary' AS somatic_summary,
            stages->'memoryRecord'->>'oracle_question_left_open' AS open_question,
            stages->>'entryType' AS entry_type,
            created_at
     FROM dreams
     WHERE user_id=$1
       AND stages->'memoryRecord' IS NOT NULL
       ${dateClause}
     ORDER BY created_at ASC`,
    params
  );

  const symbolRows = await db.query(
    `SELECT symbol, symbol_type, COUNT(*) as freq,
            MIN(created_at) as first_seen,
            MAX(created_at) as last_seen
     FROM symbol_index
     WHERE user_id=$1
     GROUP BY symbol, symbol_type
     ORDER BY freq DESC
     LIMIT 15`,
    [userId]
  );

  return { alchRows, symbolRows };
}

/**
 * Deterministic pressure score for a symbol based on memoryRecord data.
 * pressure_score = (frequency*15) + (emotional_intensity*25) + (somatic_charge_present*20)
 *                + (engagement_level_inverse*25) + (recency_weight*15)
 */
function calcPressureScore(symbol, allEntries, totalDays) {
  const appearances = [];
  allEntries.forEach(row => {
    const images = row.images || [];
    images.forEach(img => {
      if (!img || !img.symbol) return;
      if (img.symbol.toLowerCase() === symbol.toLowerCase()) {
        appearances.push(img);
      }
    });
  });
  if (appearances.length === 0) return 0;

  const frequency = Math.min(appearances.length, 10);

  const avgIntensity = appearances.reduce((sum, img) => {
    const v = typeof img.emotional_intensity === 'number' ? img.emotional_intensity : 0;
    return sum + v;
  }, 0) / appearances.length;
  // Normalize 0-4 scale to 0-100 for weighting
  const emotional_intensity = avgIntensity; // 0-4

  const somatic_charge_present = appearances.some(img => img.somatic_charge === true) ? 1 : 0;

  const engagementMap = {
    active_relationship: 0,
    partially_metabolized: 1,
    observed_not_engaged: 2,
    avoided: 3,
    never_addressed: 4
  };
  const lastEngagement = appearances[appearances.length - 1].engagement_level || 'observed_not_engaged';
  const engagement_level_inverse = engagementMap[lastEngagement] ?? 2;

  // Recency weight: days since last appearance inverted
  const lastEntry = allEntries[allEntries.length - 1];
  const firstEntry = allEntries[0];
  const totalRecordDays = totalDays || 1;
  // Find most recent appearance date
  const lastAppDate = new Date(allEntries.filter(row => {
    const images = row.images || [];
    return images.some(img => img && img.symbol && img.symbol.toLowerCase() === symbol.toLowerCase());
  }).pop()?.created_at || Date.now());
  const daysSinceLast = Math.max(0, (Date.now() - lastAppDate.getTime()) / (1000 * 60 * 60 * 24));
  const recency_weight = Math.max(0, 1 - (daysSinceLast / totalRecordDays));

  const score = (
    (frequency * 15) +
    (emotional_intensity * 25) +
    (somatic_charge_present * 20) +
    (engagement_level_inverse * 25) +
    (recency_weight * 15)
  );

  return Math.round(Math.min(score, 100));
}

/**
 * Build the source data block passed to Prompt One.
 */
function buildClinicalSourceData(alchRows) {
  const entries = alchRows.rows;
  if (!entries.length) return null;

  const firstDate = new Date(entries[0].created_at);
  const lastDate = new Date(entries[entries.length - 1].created_at);
  const totalDays = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24));

  // Alchemical sequence
  const alchemicalSequence = entries.map(r => {
    const alch = r.alch || {};
    const ind = r.individuation || {};
    return `[${r.entry_type||'dream'}] ${r.date||''} — ${alch.primary||'unmapped'}${alch.secondary?'/'+alch.secondary:''}${alch.transition?' (transition)':''}${ind.threshold_crossed?' | THRESHOLD: '+ind.threshold_description:''}`;
  }).join('\n');

  // All memoryRecords — trimmed to fields Prompt One actually uses
  const memoryRecords = entries.map(r => {
    // Strip images to only the fields needed for pressure scoring + engagement
    const images = (r.images || []).map(img => img ? {
      symbol: img.symbol,
      intensity: img.intensity,
      emotional_intensity: img.emotional_intensity,
      somatic_charge: img.somatic_charge,
      engagement_level: img.engagement_level,
      body_location: img.body_location
    } : null).filter(Boolean);
    // Strip figures to name + archetypal_category + relationship_state
    const figures = (r.figures || []).map(f => f ? {
      name: f.name,
      archetypal_category: f.archetypal_category,
      relationship_state: f.relationship_state || f.relationship_to_dreamer
    } : null).filter(Boolean);
    return {
      date: r.date || (r.created_at ? new Date(r.created_at).toISOString().slice(0,10) : ''),
      entry_type: r.entry_type,
      alch_primary: r.alch ? r.alch.primary : null,
      alch_transition: r.alch ? r.alch.transition : false,
      threshold_crossed: r.individuation ? r.individuation.threshold_crossed : false,
      threshold_description: r.individuation ? r.individuation.threshold_description : null,
      images,
      figures,
      somatic_summary: r.somatic_summary || null,
      open_question: r.open_question || null
    };
  });

  // Symbol pressure index (deterministic pre-score)
  const symbolSet = new Set();
  entries.forEach(row => {
    (row.images || []).forEach(img => { if (img && img.symbol) symbolSet.add(img.symbol); });
  });
  const symbolPressures = Array.from(symbolSet).map(sym => ({
    symbol: sym,
    pressure_score: calcPressureScore(sym, entries, totalDays),
    frequency: entries.filter(r => (r.images||[]).some(img => img && img.symbol && img.symbol.toLowerCase() === sym.toLowerCase())).length
  })).sort((a, b) => b.pressure_score - a.pressure_score).slice(0, 10);

  // Figure appearances
  const figureMap = {};
  entries.forEach(row => {
    (row.figures || []).forEach(f => {
      if (!f || !f.name) return;
      if (!figureMap[f.name]) {
        figureMap[f.name] = { first: { date: row.date || row.created_at, ...f }, last: { date: row.date || row.created_at, ...f }, count: 0 };
      }
      figureMap[f.name].last = { date: row.date || row.created_at, ...f };
      figureMap[f.name].count++;
    });
  });

  // Open questions
  const openQuestions = entries
    .filter(r => r.open_question && r.open_question.trim())
    .map(r => ({ date: r.date || r.created_at, question: r.open_question }));

  // Integration gap indicator
  // Conceptual articulation: proxy = individuation markers with threshold descriptions and open question richness
  const thresholdCount = entries.filter(r => r.individuation && r.individuation.threshold_crossed).length;
  const questionRichness = openQuestions.length;
  const conceptualScore = Math.min(100, (thresholdCount * 15) + (questionRichness * 5) + (entries.length * 2));
  // Somatic metabolization: proxy = how often somatic locations shift vs repeat
  const somaticEntries = entries.filter(r => r.somatic_summary && r.somatic_summary.trim());
  const somaticShift = somaticEntries.length > 1 ? Math.min(100, somaticEntries.length * 10) : 0;
  const integrationGap = Math.max(0, conceptualScore - somaticShift);

  return {
    entryCount: entries.length,
    totalDays: Math.round(totalDays),
    alchemicalSequence,
    memoryRecords: JSON.stringify(memoryRecords, null, 2),
    symbolPressures: JSON.stringify(symbolPressures, null, 2),
    figureMap: JSON.stringify(Object.values(figureMap).sort((a, b) => b.count - a.count), null, 2),
    openQuestions: JSON.stringify(openQuestions, null, 2),
    integrationGap,
    conceptualScore,
    somaticMetabolizationScore: somaticShift
  };
}

// ── POST /api/clinical/analyze — Prompt One: pattern extraction → clinical_analysis JSON ──
// Accepts analyst JWT with ?as=<patientId>
app.post('/api/clinical/analyze', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  let targetUserId;
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    if (payload.analystId) {
      const patientId = parseInt(req.query.as);
      if (!patientId) return res.status(400).json({ error: 'Analyst must supply ?as=<patientId>' });
      const linkRow = await db.query(
        `SELECT id FROM analyst_patient_links WHERE analyst_id=$1 AND patient_user_id=$2 AND status='active'`,
        [payload.analystId, patientId]
      );
      if (!linkRow.rows.length) return res.status(403).json({ error: 'No active link with this patient' });
      targetUserId = patientId;
    } else {
      targetUserId = payload.userId;
    }
  } catch { return res.status(401).json({ error: 'Invalid token' }); }

  try {
    const fromDate = req.query.from || null;
    const { alchRows } = await gatherPatientClinicalData(targetUserId, fromDate);
    if (!alchRows.rows.length) {
      return res.json({ success: true, analysis: null, message: fromDate ? `No mapped entries since ${fromDate}` : 'No mapped entries yet' });
    }

    const src = buildClinicalSourceData(alchRows);

    const promptOne = `You are the analytical intelligence layer of Mandala — a Jungian depth psychology tool. Your task is not to converse or interpret. Your task is to extract precise clinical patterns from structured patient data and render them as JSON.

Analyze the following memoryRecords, symbol pressure index, figure appearances, individuation markers, and oracle questions left open.

Extract and return exactly:

1. Primary and secondary blockage type — choose from: repression, inflation, projection, dissociation.
   Evidence each with specific entry references (dates/entry types).

2. Individuation stage and completion status — choose from: persona_dissolution, shadow_encounter, anima_animus_integration, self_emergence.
   Name what specifically remains incomplete.

3. Next threshold — one precise sentence naming what the individuation process is currently requiring.

4. Symbol pressure index — top five symbols ranked by pressure. For each: first appearance context, most recent appearance context, delta between them, engagement_level, pressure_score.

5. Figure relationship matrix — every recurring figure mapped as: avoided, projected, or active_relationship.
   Movement across entries: static, developing, or regressing. Ego stance in one phrase.

6. Somatic thread — historical charge locations, current primary location.
   Integration gap: low (<15), medium (15-30), or high (>30).
   Conceptual articulation score: ${src.conceptualScore}
   Somatic metabolization score: ${src.somaticMetabolizationScore}
   Integration gap value: ${src.integrationGap}

7. Transcendent function status — tension_held, tension_collapsed, or tension_overwhelmed.
   Name specifically which questions are being genuinely carried and which have been prematurely resolved.

8. Analyst focus directive — three elements:
   - primary_blockage: one sentence naming the most significant place where psychic energy is currently dammed
   - immediate_threshold: one sentence naming the specific next movement the individuation process is requiring
   - entry_points: array of 2-3 high-pressure symbols or figures the analyst might use as entry points

Keep all string values compact — evidence fields: ≤15 words; appearance context fields: ≤10 words; ego_stance: ≤8 words. Arrays capped at 5 items max. This keeps output within token limits.

Return clean JSON only. No prose. No markdown. Use this exact structure:
{
  "primary_blockage_type": "",
  "secondary_blockage_type": "",
  "primary_blockage_evidence": "",
  "secondary_blockage_evidence": "",
  "individuation_stage": "",
  "individuation_incomplete_because": "",
  "next_threshold": "",
  "symbol_pressure_index": [
    {
      "symbol": "",
      "pressure_score": 0,
      "first_appearance": "",
      "most_recent_appearance": "",
      "delta": "",
      "engagement_level": ""
    }
  ],
  "figure_relationship_matrix": [
    {
      "figure": "",
      "relationship_state": "",
      "movement": "",
      "ego_stance": "",
      "first_appearance_date": "",
      "most_recent_date": ""
    }
  ],
  "somatic_thread": {
    "historical_charge_locations": [],
    "current_primary_location": "",
    "integration_gap": "",
    "integration_gap_value": ${src.integrationGap},
    "conceptual_articulation_score": ${src.conceptualScore},
    "somatic_metabolization_score": ${src.somaticMetabolizationScore}
  },
  "transcendent_function_status": "",
  "questions_genuinely_carried": [],
  "questions_prematurely_resolved": [],
  "analyst_focus_directive": {
    "primary_blockage": "",
    "immediate_threshold": "",
    "entry_points": []
  }
}

SOURCE DATA (${src.entryCount} entries over ${src.totalDays} days):

ALCHEMICAL SEQUENCE:
${src.alchemicalSequence}

MEMORY RECORDS (all entries):
${src.memoryRecords}

SYMBOL PRESSURE INDEX (pre-calculated):
${src.symbolPressures}

FIGURE APPEARANCES:
${src.figureMap}

OPEN QUESTIONS:
${src.openQuestions}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 8096,
        messages: [{ role: 'user', content: promptOne }]
      })
    });
    if (!claudeRes.ok) throw new Error(`Claude API error: ${claudeRes.status}`);
    const claudeData = await claudeRes.json();
    const rawText = claudeData.content[0].text;
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Pattern extraction returned no JSON');
    const analysisJson = JSON.parse(match[0]);

    // Store in clinical_analysis table
    const saved = await db.query(
      `INSERT INTO clinical_analysis (patient_user_id, analysis_json, entry_count)
       VALUES ($1, $2, $3) RETURNING id, generated_at`,
      [targetUserId, JSON.stringify(analysisJson), src.entryCount]
    );

    res.json({
      success: true,
      analysisId: saved.rows[0].id,
      analysis: analysisJson,
      entryCount: src.entryCount,
      generatedAt: saved.rows[0].generated_at
    });

  } catch(e) {
    console.error('Clinical analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/clinical/brief — generate four-section clinical brief ─────────────
// Accepts: patient JWT (their own record) OR analyst JWT with ?as=<patientId>
app.get('/api/clinical/brief', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  const raw = header.slice(7);
  let targetUserId;
  try {
    const payload = jwt.verify(raw, JWT_SECRET);
    if (payload.analystId) {
      // Analyst access — must supply ?as=patientId and have active link
      const patientId = parseInt(req.query.as);
      if (!patientId) return res.status(400).json({ error: 'Analyst must supply ?as=<patientId>' });
      const linkRow = await db.query(
        `SELECT id FROM analyst_patient_links WHERE analyst_id=$1 AND patient_user_id=$2 AND status='active'`,
        [payload.analystId, patientId]
      );
      if (!linkRow.rows.length) return res.status(403).json({ error: 'No active link with this patient' });
      targetUserId = patientId;
    } else {
      targetUserId = payload.userId;
    }
  } catch { return res.status(401).json({ error: 'Invalid token' }); }

  req.userId = targetUserId;
  try {
    const fromDate = req.query.from || null; // optional YYYY-MM-DD
    const { alchRows } = await gatherPatientClinicalData(req.userId, fromDate);

    if (alchRows.rows.length === 0) {
      return res.json({ success: true, brief: null, message: fromDate ? `No mapped entries since ${fromDate}` : 'No mapped entries yet' });
    }

    const src = buildClinicalSourceData(alchRows);
    const entryCount = src.entryCount;

    // Step 1 — Run Prompt One (pattern extraction) to get clinical analysis JSON
    const promptOne = `You are the analytical intelligence layer of Mandala — a Jungian depth psychology tool. Your task is not to converse or interpret. Your task is to extract precise clinical patterns from structured patient data and render them as JSON.

Analyze the following memoryRecords, symbol pressure index, figure appearances, individuation markers, and oracle questions left open.

Extract and return exactly:

1. Primary and secondary blockage type — choose from: repression, inflation, projection, dissociation.
   Evidence each with specific entry references (dates/entry types).

2. Individuation stage and completion status — choose from: persona_dissolution, shadow_encounter, anima_animus_integration, self_emergence.
   Name what specifically remains incomplete.

3. Next threshold — one precise sentence naming what the individuation process is currently requiring.

4. Symbol pressure index — top five symbols ranked by pressure. For each: first appearance context, most recent appearance context, delta between them, engagement_level, pressure_score.

5. Figure relationship matrix — every recurring figure mapped as: avoided, projected, or active_relationship.
   Movement across entries: static, developing, or regressing. Ego stance in one phrase.

6. Somatic thread — historical charge locations, current primary location.
   Integration gap assessment — low (<15), medium (15-30), or high (>30).
   Pre-calculated values: conceptual_articulation_score=${src.conceptualScore}, somatic_metabolization_score=${src.somaticMetabolizationScore}, gap=${src.integrationGap}.

7. Transcendent function status — tension_held, tension_collapsed, or tension_overwhelmed.
   Name specifically which questions are being genuinely carried and which have been prematurely resolved.

8. Analyst focus directive — three elements:
   - primary_blockage: one sentence naming the most significant place where psychic energy is currently dammed
   - immediate_threshold: one sentence naming the specific next movement the individuation process is requiring
   - entry_points: array of 2-3 high-pressure symbols or figures the analyst might use as entry points

Keep all string values compact — evidence fields: ≤15 words; appearance context fields: ≤10 words; ego_stance: ≤8 words. Arrays capped at 5 items max. This keeps output within token limits.

Return clean JSON only. No prose. No markdown fences. Use this exact structure:
{
  "primary_blockage_type": "",
  "secondary_blockage_type": "",
  "primary_blockage_evidence": "",
  "secondary_blockage_evidence": "",
  "individuation_stage": "",
  "individuation_incomplete_because": "",
  "next_threshold": "",
  "symbol_pressure_index": [
    { "symbol": "", "pressure_score": 0, "first_appearance": "", "most_recent_appearance": "", "delta": "", "engagement_level": "" }
  ],
  "figure_relationship_matrix": [
    { "figure": "", "relationship_state": "", "movement": "", "ego_stance": "", "first_appearance_date": "", "most_recent_date": "" }
  ],
  "somatic_thread": {
    "historical_charge_locations": [],
    "current_primary_location": "",
    "integration_gap": "",
    "integration_gap_value": ${src.integrationGap},
    "conceptual_articulation_score": ${src.conceptualScore},
    "somatic_metabolization_score": ${src.somaticMetabolizationScore}
  },
  "transcendent_function_status": "",
  "questions_genuinely_carried": [],
  "questions_prematurely_resolved": [],
  "analyst_focus_directive": {
    "primary_blockage": "",
    "immediate_threshold": "",
    "entry_points": []
  }
}

SOURCE DATA (${src.entryCount} entries over ${src.totalDays} days):

ALCHEMICAL SEQUENCE:
${src.alchemicalSequence}

MEMORY RECORDS:
${src.memoryRecords}

SYMBOL PRESSURE INDEX (pre-calculated):
${src.symbolPressures}

FIGURE APPEARANCES:
${src.figureMap}

OPEN QUESTIONS:
${src.openQuestions}`;

    const p1Res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 8096, messages: [{ role: 'user', content: promptOne }] })
    });
    if (!p1Res.ok) throw new Error(`Pattern extraction API error: ${p1Res.status}`);
    const p1Data = await p1Res.json();
    const p1Raw = p1Data.content[0].text;
    // Strip markdown fences if present, then extract JSON object
    const p1Cleaned = p1Raw.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/,'').trim();
    const p1Match = p1Cleaned.match(/\{[\s\S]*\}/);
    if (!p1Match) throw new Error('Pattern extraction returned no JSON — raw: ' + p1Raw.slice(0, 200));
    let analysisJson;
    try {
      analysisJson = JSON.parse(p1Match[0]);
    } catch(parseErr) {
      throw new Error('Pattern extraction JSON parse failed: ' + parseErr.message + ' — raw (truncated): ' + p1Match[0].slice(0, 300));
    }

    // Store clinical analysis
    await db.query(
      `INSERT INTO clinical_analysis (patient_user_id, analysis_json, entry_count) VALUES ($1, $2, $3)`,
      [req.userId, JSON.stringify(analysisJson), entryCount]
    );

    // Step 2 — Run Prompt Two (prose rendering from JSON) → 8-section brief
    const promptTwo = `You are generating a clinical brief for a Jungian analyst. You have received structured pattern data extracted from a patient's Mandala record. Your task is to render this data as precise clinical prose — eight sections, maximum three pages.

You are not the Oracle. You do not interpret beyond what the data holds. You do not converse. You do not reassure. You write as one clinician communicating to another — with economy, precision, and genuine respect for the symbolic language.

Three principles govern every sentence:
One — name what is actually there, not what might be there. If the data is ambiguous, say so.
Two — the analyst is the clinician. You are the pattern reader. Never tell the analyst what to do — point to what the data shows and trust their clinical judgment with what comes next.
Three — Jung's framework is the lens, not the conclusion. The brief surfaces patterns. The analyst makes meaning with the patient in the room.

Render the following sections in this exact order. Use bold markdown headers exactly as written:

**ANALYST FOCUS DIRECTIVE** — half page maximum. Draw directly from analyst_focus_directive in the JSON. This is what the analyst reads in the first sixty seconds. No warmup. No context-setting. Primary blockage, immediate threshold, entry points. That is all.

**THE ARC** — prose narrative of alchemical trajectory. Draw from alchemical_sequence and individuation data. Name direction, duration, what is moving, what is stalled. One paragraph.

**THE BLOCKAGE MAP** — name primary and secondary blockage types. Evidence each with specific entry references from the data. Name what the blockage is protecting against. Two paragraphs maximum.

**THE INDIVIDUATION STAGE** — locate precisely within the four stages. Name what remains incomplete and what the specific next threshold requires. Two paragraphs maximum.

**THE SYMBOL PRESSURE INDEX** — render top three to five symbols in descending pressure order. For each: one paragraph covering first appearance, most recent appearance, what has changed or conspicuously has not changed, current engagement level. Do not editorialize. Let the delta speak.

**THE FIGURE RELATIONSHIP MATRIX** — render each recurring figure in one paragraph. Name relationship state, movement across entries, ego stance. The delta between first and most recent appearance is the clinical signal — name it explicitly.

**THE BODY THREAD** — render somatic timeline as clinical narrative. Where charge has lived historically, where it lives now, the integration gap named precisely. If the gap between conceptual sophistication and body metabolization is high — say so directly. This is not a judgment. It is the most important clinical signal in the record.

**THE TRANSCENDENT FUNCTION STATUS** — name current status precisely. Which questions are being genuinely carried. Which have been prematurely resolved and what they were carrying before collapse occurred. What the analyst needs to protect or slow. One paragraph.

**THE OPEN QUESTIONS** — render chronologically. No editorializing. These are the points where the patient is suspended. Present them as the analyst's entry point map.

SOURCE JSON:
${JSON.stringify(analysisJson, null, 2)}`;

    const p2Res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4096, messages: [{ role: 'user', content: promptTwo }] })
    });
    if (!p2Res.ok) throw new Error(`Brief generation API error: ${p2Res.status}`);
    const p2Data = await p2Res.json();
    const briefText = p2Data.content[0].text;

    // Persist to archive
    const generatedBy = 'analyst';
    const saved = await db.query(
      `INSERT INTO clinical_briefs (patient_user_id, brief_text, entry_count, generated_by, analysis_json, from_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, generated_at`,
      [req.userId, briefText, entryCount, generatedBy, JSON.stringify(analysisJson), fromDate || null]
    );

    res.json({
      success: true,
      brief: briefText,
      analysis: analysisJson,
      briefId: saved.rows[0].id,
      entryCount,
      fromDate: fromDate || null,
      generatedAt: saved.rows[0].generated_at
    });

  } catch(e) {
    console.error('Clinical brief error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/clinical/briefs — list archived briefs for a patient ──────────────
// Accepts patient JWT or analyst JWT with ?as=<patientId>
app.get('/api/clinical/briefs', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    let targetUserId;
    if (payload.analystId) {
      const patientId = parseInt(req.query.as);
      if (!patientId) return res.status(400).json({ error: 'Analyst must supply ?as=<patientId>' });
      const linkRow = await db.query(
        `SELECT id FROM analyst_patient_links WHERE analyst_id=$1 AND patient_user_id=$2 AND status='active'`,
        [payload.analystId, patientId]
      );
      if (!linkRow.rows.length) return res.status(403).json({ error: 'No active link with this patient' });
      targetUserId = patientId;
    } else {
      targetUserId = payload.userId;
    }
    const r = await db.query(
      `SELECT id, entry_count, generated_by, generated_at, from_date
       FROM clinical_briefs WHERE patient_user_id=$1
       ORDER BY generated_at DESC LIMIT 20`,
      [targetUserId]
    );
    res.json({ briefs: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/clinical/briefs/:id — fetch one archived brief ───────────────────
app.get('/api/clinical/briefs/:id', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    let targetUserId;
    if (payload.analystId) {
      const patientId = parseInt(req.query.as);
      if (!patientId) return res.status(400).json({ error: 'Analyst must supply ?as=<patientId>' });
      const linkRow = await db.query(
        `SELECT id FROM analyst_patient_links WHERE analyst_id=$1 AND patient_user_id=$2 AND status='active'`,
        [payload.analystId, patientId]
      );
      if (!linkRow.rows.length) return res.status(403).json({ error: 'No active link with this patient' });
      targetUserId = patientId;
    } else {
      targetUserId = payload.userId;
    }
    const r = await db.query(
      `SELECT id, brief_text, entry_count, generated_by, generated_at, analysis_json, from_date
       FROM clinical_briefs WHERE id=$1 AND patient_user_id=$2`,
      [req.params.id, targetUserId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Brief not found' });
    res.json({ brief: r.rows[0].brief_text, analysis: r.rows[0].analysis_json, ...r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Analyst auth middleware ────────────────────────────────────────────────────
function analystAuthMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    if (!payload.analystId) return res.status(403).json({ error: 'Not an analyst account' });
    req.analystId = payload.analystId;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── POST /api/analyst/register — create analyst account ───────────────────────
app.post('/api/analyst/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await db.query(
      'INSERT INTO analyst_accounts (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name',
      [email.toLowerCase().trim(), hash, name || null]
    );
    const token = jwt.sign({ analystId: r.rows[0].id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, analyst: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/analyst/login ────────────────────────────────────────────────────
app.post('/api/analyst/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const r = await db.query('SELECT * FROM analyst_accounts WHERE email=$1', [email.toLowerCase().trim()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ analystId: r.rows[0].id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, analyst: { id: r.rows[0].id, email: r.rows[0].email, name: r.rows[0].name } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/analyst/invite — generate invite token for a patient email ───────
app.post('/api/analyst/invite', analystAuthMiddleware, async (req, res) => {
  const { patient_email } = req.body;
  if (!patient_email) return res.status(400).json({ error: 'patient_email required' });
  try {
    // Find patient user
    const uRow = await db.query('SELECT id FROM users WHERE email=$1', [patient_email.toLowerCase().trim()]);
    if (!uRow.rows.length) return res.status(404).json({ error: 'No Mandala account found for that email' });
    const patientId = uRow.rows[0].id;

    // Generate unique invite token
    const crypto = require('crypto');
    const token = crypto.randomBytes(24).toString('hex');

    const r = await db.query(
      `INSERT INTO analyst_patient_links (analyst_id, patient_user_id, invite_token, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (analyst_id, patient_user_id) DO UPDATE
         SET invite_token = $3, status = 'pending', updated_at = NOW()
       RETURNING id, invite_token`,
      [req.analystId, patientId, token]
    );
    res.json({ invite_token: r.rows[0].invite_token, link_id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/patient/consent — patient accepts analyst link via token ─────────
app.post('/api/patient/consent', authMiddleware, async (req, res) => {
  const { invite_token } = req.body;
  if (!invite_token) return res.status(400).json({ error: 'invite_token required' });
  try {
    const r = await db.query(
      `UPDATE analyst_patient_links
       SET status = 'active', patient_consented_at = NOW(), updated_at = NOW()
       WHERE invite_token = $1 AND patient_user_id = $2 AND status = 'pending'
       RETURNING id`,
      [invite_token, req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Invalid or already used token' });

    // Set consent flag on user
    await db.query('UPDATE users SET analyst_consent = TRUE WHERE id = $1', [req.userId]);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/patient/revoke — patient revokes analyst access ─────────────────
app.post('/api/patient/revoke', authMiddleware, async (req, res) => {
  const { link_id } = req.body;
  if (!link_id) return res.status(400).json({ error: 'link_id required' });
  try {
    await db.query(
      `UPDATE analyst_patient_links SET status = 'revoked', updated_at = NOW()
       WHERE id = $1 AND patient_user_id = $2`,
      [link_id, req.userId]
    );
    // Check if any active links remain; if not, clear consent flag
    const active = await db.query(
      `SELECT id FROM analyst_patient_links WHERE patient_user_id=$1 AND status='active'`,
      [req.userId]
    );
    if (!active.rows.length) {
      await db.query('UPDATE users SET analyst_consent = FALSE WHERE id = $1', [req.userId]);
    }
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/patient/links — patient sees their analyst connections ────────────
app.get('/api/patient/links', authMiddleware, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT apl.id, apl.status, apl.patient_consented_at, aa.name AS analyst_name, aa.email AS analyst_email
       FROM analyst_patient_links apl
       JOIN analyst_accounts aa ON aa.id = apl.analyst_id
       WHERE apl.patient_user_id = $1 AND apl.status != 'revoked'
       ORDER BY apl.created_at DESC`,
      [req.userId]
    );
    res.json({ links: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/analyst/patients — analyst sees their linked patients ─────────────
app.get('/api/analyst/patients', analystAuthMiddleware, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT apl.id AS link_id, apl.status, apl.patient_consented_at,
              u.email AS patient_email, u.id AS patient_id
       FROM analyst_patient_links apl
       JOIN users u ON u.id = apl.patient_user_id
       WHERE apl.analyst_id = $1 AND apl.status = 'active'
       ORDER BY apl.patient_consented_at DESC`,
      [req.analystId]
    );
    res.json({ patients: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── GET /api/analyst/brief/:patientId — analyst pulls clinical brief for active patient ──
app.get('/api/analyst/brief/:patientId', analystAuthMiddleware, async (req, res) => {
  const patientId = parseInt(req.params.patientId);
  try {
    // Verify active link
    const linkRow = await db.query(
      `SELECT id FROM analyst_patient_links
       WHERE analyst_id=$1 AND patient_user_id=$2 AND status='active'`,
      [req.analystId, patientId]
    );
    if (!linkRow.rows.length) return res.status(403).json({ error: 'No active link with this patient' });

    // Forward to the same clinical brief logic, impersonating the patient user
    req.userId = patientId;
    // Reuse clinical brief generation by redirecting internally
    res.redirect(307, `/api/clinical/brief`);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── POST /api/analyst/note — analyst leaves a note for the Oracle ──────────────
app.post('/api/analyst/note', analystAuthMiddleware, async (req, res) => {
  const { patient_id, note } = req.body;
  if (!patient_id || !note) return res.status(400).json({ error: 'patient_id and note required' });
  try {
    const r = await db.query(
      `UPDATE analyst_patient_links
       SET analyst_note = $1, analyst_note_consumed = FALSE, updated_at = NOW()
       WHERE analyst_id = $2 AND patient_user_id = $3 AND status = 'active'
       RETURNING id`,
      [note.trim(), req.analystId, patient_id]
    );
    if (!r.rows.length) return res.status(403).json({ error: 'No active link with this patient' });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log('Mandala Cloud running on port ' + PORT));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
