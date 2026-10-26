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
