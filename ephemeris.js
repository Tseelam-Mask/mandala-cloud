/**
 * ephemeris.js — Mandala astrological layer
 *
 * Add to Railway backend. Exposes:
 *   GET /api/ephemeris?date=ISO&lat=&lon=      → current sky positions
 *   POST /api/ephemeris/natal                  → natal chart for birth data
 *   POST /api/ephemeris/transits               → active transits (natal vs now)
 *
 * Install: npm install swisseph
 * The swisseph package ships ephemeris data files — no external API needed.
 */

let swisseph;
try {
  swisseph = require('swisseph');
  console.log('[ephemeris] swisseph loaded OK');
} catch(e) {
  console.error('[ephemeris] swisseph FAILED to load:', e.message);
}
const express  = require('express');
const router   = express.Router();

// ── Planet list ──────────────────────────────────────────────────────────────
// Each planet: swisseph body constant + name + Jungian psychological function
const PLANETS = [
  { id: swisseph.SE_SUN,     name: 'Sun',     jungian: 'Ego — the conscious organising centre' },
  { id: swisseph.SE_MOON,    name: 'Moon',    jungian: 'Unconscious — instinct, mother complex, body knowing' },
  { id: swisseph.SE_MERCURY, name: 'Mercury', jungian: 'Psychopomp — communication between conscious and unconscious' },
  { id: swisseph.SE_VENUS,   name: 'Venus',   jungian: 'Anima pole — receptivity, beauty, relational feeling' },
  { id: swisseph.SE_MARS,    name: 'Mars',    jungian: 'Animus pole — drive, assertion, directed will' },
  { id: swisseph.SE_JUPITER, name: 'Jupiter', jungian: 'Expansion — what is trying to grow, the Self\'s abundance' },
  { id: swisseph.SE_SATURN,  name: 'Saturn',  jungian: 'Shadow enforcer — limitation, reality principle, necessary loss' },
  { id: swisseph.SE_URANUS,  name: 'Uranus',  jungian: 'Individuation shock — the Self breaking old containers' },
  { id: swisseph.SE_NEPTUNE, name: 'Neptune', jungian: 'Collective unconscious — dissolution, mystical flooding' },
  { id: swisseph.SE_PLUTO,   name: 'Pluto',   jungian: 'Death-rebirth archetype — radical transformation, the Self\'s deepest demand' },
  { id: swisseph.SE_TRUE_NODE, name: 'NorthNode', jungian: 'Individuation direction — karmic trajectory' },
];

// Zodiac signs with alchemical + Jungian quality
const SIGNS = [
  { name: 'Aries',       element: 'fire',  mode: 'cardinal', quality: 'initiation, raw will, first impulse' },
  { name: 'Taurus',      element: 'earth', mode: 'fixed',    quality: 'embodiment, persistence, the material ground' },
  { name: 'Gemini',      element: 'air',   mode: 'mutable',  quality: 'multiplicity, the trickster, mental agility' },
  { name: 'Cancer',      element: 'water', mode: 'cardinal', quality: 'the maternal, emotional memory, the ancestral field' },
  { name: 'Leo',         element: 'fire',  mode: 'fixed',    quality: 'creative Self-expression, the solar principle, generosity' },
  { name: 'Virgo',       element: 'earth', mode: 'mutable',  quality: 'discernment, service, the alchemical vessel of refinement' },
  { name: 'Libra',       element: 'air',   mode: 'cardinal', quality: 'relationship as mirror, the anima/animus encounter, balance' },
  { name: 'Scorpio',     element: 'water', mode: 'fixed',    quality: 'depth, shadow territory, transformation through descent' },
  { name: 'Sagittarius', element: 'fire',  mode: 'mutable',  quality: 'meaning-seeking, expansion of the horizon, the mythic journey' },
  { name: 'Capricorn',   element: 'earth', mode: 'cardinal', quality: 'the reality principle, structure, Saturn\'s own domain' },
  { name: 'Aquarius',    element: 'air',   mode: 'fixed',    quality: 'collective consciousness, the Self beyond the personal ego' },
  { name: 'Pisces',      element: 'water', mode: 'mutable',  quality: 'dissolution of ego boundaries, mystical unity, the ocean of the unconscious' },
];

// Houses and their life territory (psychological domain)
const HOUSE_DOMAINS = [
  '',  // index 0 unused
  'Self and body — the ego\'s home territory',
  'Resources, values, what the psyche holds onto',
  'Mind, communication, the sibling complex',
  'Home, ancestry, the mother field',
  'Creativity, children, the inner child',
  'Work, health, service and the body\'s limits',
  'Partnership, the shadow the other carries for you',
  'Depth, shared resources, death and inheritance',
  'Belief, higher learning, the mythic horizon',
  'Career, public life, the father complex',
  'Community, ideals, the collective',
  'Solitude, the unconscious, hidden enemies — what is dissolving',
];

// ── Utility — Julian Day from ISO date string ───────────────────────────────
function isoToJD(isoString) {
  const d = new Date(isoString);
  const year  = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day   = d.getUTCDate();
  const hour  = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  return swisseph.swe_julday(year, month, day + hour / 24, swisseph.SE_GREG_CAL);
}

// ── Calculate one planet's position ─────────────────────────────────────────
function calcPlanet(jd, planetId) {
  const result = swisseph.swe_calc_ut(jd, planetId, swisseph.SEFLG_SWIEPH | swisseph.SEFLG_SPEED);
  if (result.error) return null;
  const longitude = result.longitude;
  const signIndex = Math.floor(longitude / 30);
  const degree    = longitude % 30;
  const sign      = SIGNS[signIndex];
  return {
    longitude: parseFloat(longitude.toFixed(4)),
    sign:      sign.name,
    signIndex,
    degree:    parseFloat(degree.toFixed(2)),
    element:   sign.element,
    mode:      sign.mode,
    quality:   sign.quality,
    retrograde: result.longitudeSpeed < 0,
    speed:     parseFloat(result.longitudeSpeed.toFixed(4)),
  };
}

// ── Calculate houses (Placidus) ──────────────────────────────────────────────
function calcHouses(jd, lat, lon) {
  try {
    const h = swisseph.swe_houses(jd, lat, lon, 'P'); // P = Placidus
    return {
      cusps:     h.house.slice(1, 13).map((c, i) => ({
        house:   i + 1,
        longitude: parseFloat(c.toFixed(4)),
        sign:    SIGNS[Math.floor(c / 30) % 12].name,
        degree:  parseFloat((c % 30).toFixed(2)),
        domain:  HOUSE_DOMAINS[i + 1],
      })),
      ascendant: parseFloat(h.ascendant.toFixed(4)),
      mc:        parseFloat(h.mc.toFixed(4)),
    };
  } catch (e) {
    return null;
  }
}

// ── Build full sky snapshot ──────────────────────────────────────────────────
function buildSkySnapshot(jd, lat, lon) {
  const positions = {};
  for (const p of PLANETS) {
    const pos = calcPlanet(jd, p.id);
    if (pos) {
      positions[p.name] = { ...pos, jungian: p.jungian };
    }
  }
  const houses = (lat != null && lon != null) ? calcHouses(jd, lat, lon) : null;
  return { positions, houses };
}

// ── Detect active transits (natal vs sky) ────────────────────────────────────
// An aspect is "active" when orb is within threshold
const ASPECTS = [
  { name: 'conjunction', angle: 0,   orb: 8,  nature: 'fusion — intensification of both themes' },
  { name: 'opposition',  angle: 180, orb: 8,  nature: 'tension — the two must be held simultaneously' },
  { name: 'trine',       angle: 120, orb: 6,  nature: 'flow — natural integration, gifts made easy' },
  { name: 'square',      angle: 90,  orb: 6,  nature: 'friction — the growth edge, creative tension' },
  { name: 'sextile',     angle: 60,  orb: 4,  nature: 'opportunity — a door opening, requires action' },
];

function detectTransits(natalPositions, currentPositions) {
  const transits = [];
  for (const [transitPlanet, transitPos] of Object.entries(currentPositions)) {
    for (const [natalPlanet, natalPos] of Object.entries(natalPositions)) {
      const diff = Math.abs(transitPos.longitude - natalPos.longitude);
      const angle = diff > 180 ? 360 - diff : diff;
      for (const aspect of ASPECTS) {
        const orb = Math.abs(angle - aspect.angle);
        if (orb <= aspect.orb) {
          // Applying (closing) vs separating — applying transits are stronger
          const applying = transitPos.speed > 0
            ? transitPos.longitude < natalPos.longitude
            : transitPos.longitude > natalPos.longitude;
          transits.push({
            transitPlanet,
            natalPlanet,
            aspect:   aspect.name,
            orb:      parseFloat(orb.toFixed(2)),
            applying,
            nature:   aspect.nature,
            // Psychological summary for the Oracle
            oracleContext: buildTransitContext(transitPlanet, natalPlanet, aspect.name, currentPositions[transitPlanet], orb, applying),
          });
        }
      }
    }
  }
  // Sort by tightness (lowest orb first — most active transits)
  return transits.sort((a, b) => a.orb - b.orb);
}

// ── Build the Oracle's silent astrological context ───────────────────────────
// This is what gets injected into the system prompt — never shown to user
function buildTransitContext(transitPlanet, natalPlanet, aspect, currentPos, orb, applying) {
  const planetContexts = {
    Saturn:  'a quality of necessary limitation, reality confrontation, or shadow work is particularly alive',
    Pluto:   'deep transformational pressure is active — the Self demanding radical reorganisation',
    Neptune: 'the boundaries between conscious and unconscious are thinner than usual',
    Uranus:  'an individuating shock may be occurring — an old container breaking',
    Jupiter: 'an expansive energy is present — something trying to grow or be freed',
    Mars:    'assertive or confrontational energy is heightened — directed will is being called for',
    Venus:   'relational or anima/animus themes are particularly present',
    Mercury: 'communication between inner layers is active — dreams and symbols may be vivid',
    Sun:     'ego-strength and conscious identity themes are foregrounded',
    Moon:    'unconscious material, emotional instinct, or the mother complex is particularly active',
    NorthNode: 'the individuation direction is being pressured into awareness',
  };

  const natalContexts = {
    Sun:      'the core ego and sense of conscious self',
    Moon:     'emotional instinct and unconscious habits',
    Saturn:   'the shadow enforcer and reality principle within',
    Pluto:    'the inner death-rebirth archetype',
    Neptune:  'the mystical or dissolution-prone dimension',
    Jupiter:  'the inner sense of meaning and expansion',
    Mars:     'inner drive and assertive force',
    Venus:    'inner receptivity and relational feeling',
    Mercury:  'the psychopomp function — inner communication',
    Uranus:   'the individuating shock principle within',
    NorthNode: 'the soul\'s directional pull',
  };

  const transitCtx = planetContexts[transitPlanet] || `${transitPlanet} themes are active`;
  const natalCtx   = natalContexts[natalPlanet]    || `the natal ${natalPlanet}`;
  const strength   = orb < 2 ? 'very exact' : orb < 4 ? 'close' : 'forming';
  const timing     = applying ? 'building toward culmination' : 'beginning to separate';

  return `${transitPlanet} is in ${aspect} (${strength}, ${timing}) with natal ${natalPlanet} — ${transitCtx}, particularly touching ${natalCtx}.`;
}

// ── Build the full Oracle astrological context string ───────────────────────
// This is what the system prompt receives as silent background
function buildOracleAstroContext(transits, currentSky, natalChart) {
  if (!transits || transits.length === 0) return '';

  // Only include the 5 most significant (tightest orb) transits
  const significant = transits.slice(0, 5);

  // Dominant sky theme
  const sun  = currentSky.positions['Sun'];
  const moon = currentSky.positions['Moon'];
  const skyTheme = sun && moon
    ? `Current sky: Sun in ${sun.sign} (${sun.quality}), Moon in ${moon.sign} (${moon.quality}).`
    : '';

  // Saturn/Pluto/Neptune active?
  const heavyPlanets = significant.filter(t =>
    ['Saturn','Pluto','Neptune'].includes(t.transitPlanet) && t.orb < 5
  );
  const heavyNote = heavyPlanets.length > 0
    ? `\nMajor archetypal transits active: ${heavyPlanets.map(t => t.oracleContext).join(' ')}`
    : '';

  const transitLines = significant.map(t => `— ${t.oracleContext}`).join('\n');

  return `\n\nASTROLOGICAL CONTEXT (background awareness — do not announce, do not use jargon):
${skyTheme}${heavyNote}
Active transits:
${transitLines}

Hold this awareness silently. Let it inform the depth and direction of your questions, not your explicit language. If astrological territory is genuinely illuminating and the user seems open, you may introduce it with: "There's something in the timing of what you're describing..." — never with planetary names unless the user brings them first.`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/ephemeris
 * Query params: date (ISO string, default now), lat, lon (optional)
 * Returns: current sky positions + houses if lat/lon provided
 */
router.get('/', (req, res) => {
  if (!swisseph) return res.status(500).json({ ok: false, error: 'swisseph not available — check build logs' });
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const lat  = req.query.lat  ? parseFloat(req.query.lat)  : null;
    const lon  = req.query.lon  ? parseFloat(req.query.lon)  : null;
    const jd   = isoToJD(date.toISOString());
    const sky  = buildSkySnapshot(jd, lat, lon);
    res.json({ ok: true, date: date.toISOString(), jd, ...sky });
  } catch (e) {
    console.error('[ephemeris] GET error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/ephemeris/natal
 * Body: { birthDate: ISO, birthLat: number, birthLon: number }
 * Returns: natal chart positions + houses + Jungian portrait fragments
 */
router.post('/natal', (req, res) => {
  try {
    const { birthDate, birthLat, birthLon } = req.body;
    if (!birthDate) return res.status(400).json({ ok: false, error: 'birthDate required' });

    const jd      = isoToJD(birthDate);
    const lat     = parseFloat(birthLat) || 0;
    const lon     = parseFloat(birthLon) || 0;
    const chart   = buildSkySnapshot(jd, lat, lon);

    // Annotate with house placements
    if (chart.houses) {
      for (const [name, pos] of Object.entries(chart.positions)) {
        const house = chart.houses.cusps.findIndex((c, i) => {
          const next = chart.houses.cusps[(i + 1) % 12];
          const start = c.longitude;
          const end   = next.longitude;
          if (start < end) return pos.longitude >= start && pos.longitude < end;
          return pos.longitude >= start || pos.longitude < end;
        });
        pos.house = house >= 0 ? house + 1 : null;
        if (pos.house) pos.houseDomain = HOUSE_DOMAINS[pos.house];
      }
    }

    res.json({ ok: true, birthDate, chart });
  } catch (e) {
    console.error('[ephemeris] natal error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/ephemeris/transits
 * Body: { natalChart: {...positions}, date?: ISO, lat?, lon? }
 * Returns: active transits + oracleContext string for system prompt injection
 */
router.post('/transits', (req, res) => {
  try {
    const { natalChart, date, lat, lon } = req.body;
    if (!natalChart || !natalChart.positions) {
      return res.status(400).json({ ok: false, error: 'natalChart.positions required' });
    }

    const targetDate = date ? new Date(date) : new Date();
    const jd         = isoToJD(targetDate.toISOString());
    const currentSky = buildSkySnapshot(jd, lat || null, lon || null);
    const transits   = detectTransits(natalChart.positions, currentSky.positions);
    const oracleContext = buildOracleAstroContext(transits, currentSky, natalChart);

    res.json({
      ok: true,
      date: targetDate.toISOString(),
      currentSky,
      transits,
      oracleContext, // inject this into system prompt
    });
  } catch (e) {
    console.error('[ephemeris] transits error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = { router, buildOracleAstroContext };
