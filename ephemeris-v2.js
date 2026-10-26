/**
 * ephemeris.js — Mandala astrological layer (astronomia edition)
 *
 * Exposes:
 *   GET /api/ephemeris?date=ISO&lat=&lon=      → current sky positions
 *   POST /api/ephemeris/natal                  → natal chart for birth data
 *   POST /api/ephemeris/transits               → active transits (natal vs now)
 *
 * Uses: astronomia (pure JS, no native compilation)
 */

const express = require('express');
const router  = express.Router();

// ── Astronomia imports ───────────────────────────────────────────────────────
const {julian, solar, moonposition, planetposition, data: astroData} = require('astronomia');
const {base, coord} = require('astronomia');

// Planet data modules
const venus   = require('astronomia/data/venus');
const mars    = require('astronomia/data/mars');
const jupiter = require('astronomia/data/jupiter');
const saturn  = require('astronomia/data/saturn');
const uranus  = require('astronomia/data/uranus');
const neptune = require('astronomia/data/neptune');

// ── Zodiac signs ─────────────────────────────────────────────────────────────
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

const HOUSE_DOMAINS = [
  '',
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

// ── Utility ───────────────────────────────────────────────────────────────────

function dateToJDE(date) {
  return julian.DateToJDE(date);
}

function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

function longitudeToSign(lon) {
  const norm = normalizeDeg(lon);
  const signIndex = Math.floor(norm / 30);
  const degree    = norm % 30;
  const sign      = SIGNS[signIndex];
  return {
    longitude: parseFloat(norm.toFixed(4)),
    sign:      sign.name,
    signIndex,
    degree:    parseFloat(degree.toFixed(2)),
    element:   sign.element,
    mode:      sign.mode,
    quality:   sign.quality,
  };
}

// ── Planet calculations ───────────────────────────────────────────────────────
// Returns ecliptic longitude in degrees

function calcSun(jde) {
  const pos = solar.apparentLongitude(jde);
  return normalizeDeg(pos * 180 / Math.PI);
}

function calcMoon(jde) {
  const pos = moonposition.position(jde);
  return normalizeDeg(pos.lon * 180 / Math.PI);
}

function calcPlanet(jde, planetData) {
  try {
    const earth = new planetposition.Planet(astroData.earth);
    const planet = new planetposition.Planet(planetData);
    const pos = planet.position(jde);
    // Convert to ecliptic longitude
    const lon = normalizeDeg(pos.lon * 180 / Math.PI);
    return lon;
  } catch(e) {
    return null;
  }
}

// Approximate positions for outer planets using mean motion
// These are simplified but sufficient for psychological/oracular context
function calcOuterPlanet(jde, meanLon2000, ratePerDay) {
  const J2000 = 2451545.0;
  const daysSinceJ2000 = jde - J2000;
  return normalizeDeg(meanLon2000 + ratePerDay * daysSinceJ2000);
}

// Mean orbital elements at J2000 and daily motion (degrees/day)
const OUTER_PLANETS = {
  Jupiter: { lon2000: 34.33, rate: 0.08309 },
  Saturn:  { lon2000: 50.08, rate: 0.03346 },
  Uranus:  { lon2000: 314.06, rate: 0.01172 },
  Neptune: { lon2000: 304.35, rate: 0.00600 },
  Pluto:   { lon2000: 238.95, rate: 0.00397 },
};

// North Node (mean): moves retrograde at ~0.0529°/day
function calcNorthNode(jde) {
  const J2000 = 2451545.0;
  const days  = jde - J2000;
  return normalizeDeg(125.044 - 0.05295 * days);
}

// Mercury and Venus via full VSOP87 if available, else simplified
function calcMercury(jde) {
  const J2000 = 2451545.0;
  const T = (jde - J2000) / 36525;
  // Mean longitude simplified
  const L = 252.250906 + 149474.0722491 * T;
  return normalizeDeg(L);
}

function calcVenus(jde) {
  const J2000 = 2451545.0;
  const T = (jde - J2000) / 36525;
  const L = 181.979801 + 58519.2130302 * T;
  return normalizeDeg(L);
}

function calcMars(jde) {
  const J2000 = 2451545.0;
  const T = (jde - J2000) / 36525;
  const L = 355.433 + 19141.6964471 * T;
  return normalizeDeg(L);
}

// ── Build full sky snapshot ───────────────────────────────────────────────────

const PLANET_JUNGIAN = {
  Sun:      'Ego — the conscious organising centre',
  Moon:     'Unconscious — instinct, mother complex, body knowing',
  Mercury:  'Psychopomp — communication between conscious and unconscious',
  Venus:    'Anima pole — receptivity, beauty, relational feeling',
  Mars:     'Animus pole — drive, assertion, directed will',
  Jupiter:  'Expansion — what is trying to grow, the Self\'s abundance',
  Saturn:   'Shadow enforcer — limitation, reality principle, necessary loss',
  Uranus:   'Individuation shock — the Self breaking old containers',
  Neptune:  'Collective unconscious — dissolution, mystical flooding',
  Pluto:    'Death-rebirth archetype — radical transformation, the Self\'s deepest demand',
  NorthNode:'Individuation direction — karmic trajectory',
};

function buildSkySnapshot(date, lat, lon) {
  const jde = dateToJDE(date);

  const rawPositions = {
    Sun:       calcSun(jde),
    Moon:      calcMoon(jde),
    Mercury:   calcMercury(jde),
    Venus:     calcVenus(jde),
    Mars:      calcMars(jde),
    Jupiter:   calcOuterPlanet(jde, OUTER_PLANETS.Jupiter.lon2000, OUTER_PLANETS.Jupiter.rate),
    Saturn:    calcOuterPlanet(jde, OUTER_PLANETS.Saturn.lon2000,  OUTER_PLANETS.Saturn.rate),
    Uranus:    calcOuterPlanet(jde, OUTER_PLANETS.Uranus.lon2000,  OUTER_PLANETS.Uranus.rate),
    Neptune:   calcOuterPlanet(jde, OUTER_PLANETS.Neptune.lon2000, OUTER_PLANETS.Neptune.rate),
    Pluto:     calcOuterPlanet(jde, OUTER_PLANETS.Pluto.lon2000,   OUTER_PLANETS.Pluto.rate),
    NorthNode: calcNorthNode(jde),
  };

  // Estimate retrograde via small forward difference (1 day)
  const jde1 = jde + 1;
  const rawNext = {
    Mercury: calcMercury(jde1),
    Venus:   calcVenus(jde1),
    Mars:    calcMars(jde1),
    Jupiter: calcOuterPlanet(jde1, OUTER_PLANETS.Jupiter.lon2000, OUTER_PLANETS.Jupiter.rate),
    Saturn:  calcOuterPlanet(jde1, OUTER_PLANETS.Saturn.lon2000,  OUTER_PLANETS.Saturn.rate),
    Uranus:  calcOuterPlanet(jde1, OUTER_PLANETS.Uranus.lon2000,  OUTER_PLANETS.Uranus.rate),
    Neptune: calcOuterPlanet(jde1, OUTER_PLANETS.Neptune.lon2000, OUTER_PLANETS.Neptune.rate),
    Pluto:   calcOuterPlanet(jde1, OUTER_PLANETS.Pluto.lon2000,   OUTER_PLANETS.Pluto.rate),
  };

  const positions = {};
  for (const [name, lon] of Object.entries(rawPositions)) {
    const signData = longitudeToSign(lon);
    const nextLon  = rawNext[name];
    const speed    = nextLon != null ? nextLon - lon : 1; // positive = direct
    positions[name] = {
      ...signData,
      retrograde: speed < 0,
      speed:      parseFloat((speed || 0).toFixed(4)),
      jungian:    PLANET_JUNGIAN[name] || '',
    };
  }

  // Simplified Ascendant/houses (Placidus requires RAMC; use Whole Sign as fallback)
  let houses = null;
  if (lat != null && lon != null) {
    houses = calcWholeSignHouses(jde, lat, lon);
  }

  return { positions, houses };
}

// ── Whole-sign house system ───────────────────────────────────────────────────
// Simpler than Placidus but psychologically coherent

function calcWholeSignHouses(jde, lat, lon) {
  try {
    // Local Sidereal Time → Ascendant sign
    const J2000 = 2451545.0;
    const T = (jde - J2000) / 36525;
    // Greenwich Mean Sidereal Time in degrees
    const GMST = normalizeDeg(280.46061837 + 360.98564736629 * (jde - J2000) + 0.000387933 * T * T);
    const LST  = normalizeDeg(GMST + lon);

    // Obliquity of ecliptic
    const eps = (23.439291111 - 0.013004167 * T) * Math.PI / 180;
    const lstRad = LST * Math.PI / 180;
    const latRad = lat * Math.PI / 180;

    // Ascendant longitude
    const ascLon = normalizeDeg(
      Math.atan2(Math.cos(lstRad), -(Math.sin(eps) * Math.tan(latRad) + Math.cos(eps) * Math.sin(lstRad))) * 180 / Math.PI
    );

    const ascSignIndex = Math.floor(ascLon / 30);

    // Whole-sign: each house is a full sign starting from Ascendant sign
    const cusps = [];
    for (let i = 0; i < 12; i++) {
      const signIndex = (ascSignIndex + i) % 12;
      const cuspLon   = signIndex * 30;
      cusps.push({
        house:     i + 1,
        longitude: cuspLon,
        sign:      SIGNS[signIndex].name,
        degree:    0,
        domain:    HOUSE_DOMAINS[i + 1],
      });
    }

    return {
      cusps,
      ascendant: parseFloat(ascLon.toFixed(4)),
      ascendantSign: SIGNS[ascSignIndex].name,
    };
  } catch(e) {
    return null;
  }
}

// ── Transit detection ─────────────────────────────────────────────────────────

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
      const diff  = Math.abs(transitPos.longitude - natalPos.longitude);
      const angle = diff > 180 ? 360 - diff : diff;
      for (const aspect of ASPECTS) {
        const orb = Math.abs(angle - aspect.angle);
        if (orb <= aspect.orb) {
          const applying = transitPos.speed > 0
            ? transitPos.longitude < natalPos.longitude
            : transitPos.longitude > natalPos.longitude;
          transits.push({
            transitPlanet,
            natalPlanet,
            aspect:       aspect.name,
            orb:          parseFloat(orb.toFixed(2)),
            applying,
            nature:       aspect.nature,
            oracleContext: buildTransitContext(transitPlanet, natalPlanet, aspect.name, orb, applying),
          });
        }
      }
    }
  }
  return transits.sort((a, b) => a.orb - b.orb);
}

// ── Oracle context builders ───────────────────────────────────────────────────

function buildTransitContext(transitPlanet, natalPlanet, aspect, orb, applying) {
  const planetContexts = {
    Saturn:   'a quality of necessary limitation, reality confrontation, or shadow work is particularly alive',
    Pluto:    'deep transformational pressure is active — the Self demanding radical reorganisation',
    Neptune:  'the boundaries between conscious and unconscious are thinner than usual',
    Uranus:   'an individuating shock may be occurring — an old container breaking',
    Jupiter:  'an expansive energy is present — something trying to grow or be freed',
    Mars:     'assertive or confrontational energy is heightened — directed will is being called for',
    Venus:    'relational or anima/animus themes are particularly present',
    Mercury:  'communication between inner layers is active — dreams and symbols may be vivid',
    Sun:      'ego-strength and conscious identity themes are foregrounded',
    Moon:     'unconscious material, emotional instinct, or the mother complex is particularly active',
    NorthNode:'the individuation direction is being pressured into awareness',
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
    NorthNode:'the soul\'s directional pull',
  };

  const transitCtx = planetContexts[transitPlanet] || `${transitPlanet} themes are active`;
  const natalCtx   = natalContexts[natalPlanet]    || `the natal ${natalPlanet}`;
  const strength   = orb < 2 ? 'very exact' : orb < 4 ? 'close' : 'forming';
  const timing     = applying ? 'building toward culmination' : 'beginning to separate';

  return `${transitPlanet} is in ${aspect} (${strength}, ${timing}) with natal ${natalPlanet} — ${transitCtx}, particularly touching ${natalCtx}.`;
}

function buildOracleAstroContext(transits, currentSky, natalChart) {
  if (!transits || transits.length === 0) return '';

  const significant = transits.slice(0, 5);

  const sun  = currentSky.positions['Sun'];
  const moon = currentSky.positions['Moon'];
  const skyTheme = sun && moon
    ? `Current sky: Sun in ${sun.sign} (${sun.quality}), Moon in ${moon.sign} (${moon.quality}).`
    : '';

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
 * Query: date (ISO, default now), lat, lon (optional)
 */
router.get('/', (req, res) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const lat  = req.query.lat  ? parseFloat(req.query.lat)  : null;
    const lon  = req.query.lon  ? parseFloat(req.query.lon)  : null;
    const sky  = buildSkySnapshot(date, lat, lon);
    res.json({ ok: true, date: date.toISOString(), ...sky });
  } catch (e) {
    console.error('[ephemeris] GET error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/ephemeris/natal
 * Body: { birthDate: ISO, birthLat: number, birthLon: number }
 */
router.post('/natal', (req, res) => {
  try {
    const { birthDate, birthLat, birthLon } = req.body;
    if (!birthDate) return res.status(400).json({ ok: false, error: 'birthDate required' });

    const date  = new Date(birthDate);
    const lat   = parseFloat(birthLat) || 0;
    const lon   = parseFloat(birthLon) || 0;
    const chart = buildSkySnapshot(date, lat, lon);

    // Annotate house placements
    if (chart.houses) {
      for (const [name, pos] of Object.entries(chart.positions)) {
        const signIndex = pos.signIndex;
        const house = chart.houses.cusps.findIndex(c => SIGNS.findIndex(s => s.name === c.sign) === signIndex);
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
 */
router.post('/transits', (req, res) => {
  try {
    const { natalChart, date, lat, lon } = req.body;
    if (!natalChart || !natalChart.positions) {
      return res.status(400).json({ ok: false, error: 'natalChart.positions required' });
    }

    const targetDate    = date ? new Date(date) : new Date();
    const currentSky    = buildSkySnapshot(targetDate, lat || null, lon || null);
    const transits      = detectTransits(natalChart.positions, currentSky.positions);
    const oracleContext = buildOracleAstroContext(transits, currentSky, natalChart);

    res.json({ ok: true, date: targetDate.toISOString(), currentSky, transits, oracleContext });
  } catch (e) {
    console.error('[ephemeris] transits error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = { router, buildOracleAstroContext };
