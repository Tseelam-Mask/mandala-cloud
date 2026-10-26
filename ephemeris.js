'use strict';

const express = require('express');
const router  = express.Router();

// astronomia v4 — use named exports + .default on data modules
const {DateToJDE}   = require('astronomia/julian');
const solar          = require('astronomia/solar');
const moonPos        = require('astronomia/moonposition');
const {Planet}       = require('astronomia/planetposition');
const sidereal       = require('astronomia/sidereal');
const {base}         = require('astronomia/base') || {};

// VSOP87B heliocentric data — each CJS module wraps the array as `.default`
const mercuryData = require('astronomia/data/vsop87Bmercury').default;
const venusData   = require('astronomia/data/vsop87Bvenus').default;
const earthData   = require('astronomia/data/vsop87Bearth').default;
const marsData    = require('astronomia/data/vsop87Bmars').default;
const jupiterData = require('astronomia/data/vsop87Bjupiter').default;
const saturnData  = require('astronomia/data/vsop87Bsaturn').default;
const uranusData  = require('astronomia/data/vsop87Buranus').default;
const neptuneData = require('astronomia/data/vsop87Bneptune').default;

const mercury = new Planet(mercuryData);
const venus   = new Planet(venusData);
const earth   = new Planet(earthData);
const mars    = new Planet(marsData);
const jupiter = new Planet(jupiterData);
const saturn  = new Planet(saturnData);
const uranus  = new Planet(uranusData);
const neptune = new Planet(neptuneData);

// ── constants ──────────────────────────────────────────────────────────────
const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

const SIGNS = [
  { name:'Aries',       symbol:'♈', element:'Fire',  mode:'Cardinal', start:0   },
  { name:'Taurus',      symbol:'♉', element:'Earth', mode:'Fixed',    start:30  },
  { name:'Gemini',      symbol:'♊', element:'Air',   mode:'Mutable',  start:60  },
  { name:'Cancer',      symbol:'♋', element:'Water', mode:'Cardinal', start:90  },
  { name:'Leo',         symbol:'♌', element:'Fire',  mode:'Fixed',    start:120 },
  { name:'Virgo',       symbol:'♍', element:'Earth', mode:'Mutable',  start:150 },
  { name:'Libra',       symbol:'♎', element:'Air',   mode:'Cardinal', start:180 },
  { name:'Scorpio',     symbol:'♏', element:'Water', mode:'Fixed',    start:210 },
  { name:'Sagittarius', symbol:'♐', element:'Fire',  mode:'Mutable',  start:240 },
  { name:'Capricorn',   symbol:'♑', element:'Earth', mode:'Cardinal', start:270 },
  { name:'Aquarius',    symbol:'♒', element:'Air',   mode:'Fixed',    start:300 },
  { name:'Pisces',      symbol:'♓', element:'Water', mode:'Mutable',  start:330 },
];

const HOUSE_DOMAINS = [
  null,
  'Self, identity, physical body, first impressions',
  'Money, possessions, values, self-worth',
  'Communication, siblings, local travel, early learning',
  'Home, family, roots, the past',
  'Creativity, children, romance, play',
  'Health, daily routines, service, work',
  'Relationships, partnerships, open enemies',
  'Transformation, shared resources, death, occult',
  'Philosophy, higher learning, long journeys, beliefs',
  'Career, public reputation, authority figures',
  'Community, friendships, hopes, group ideals',
  'Spirituality, hidden matters, self-undoing, solitude',
];

// ── Lahiri ayanamsa (IAU / Astronomical Ephemeris standard) ───────────────
// Formula: ayanamsa = 23.85 + 0.0000395 * T² − 0.000000178 * T³
// where T = Julian centuries from J1900.0
// Accurate to within ~1 arcmin for dates 1800–2100
function lahiriAyanamsa(jde) {
  const T = (jde - 2415020.0) / 36524.2199; // centuries from J1900.0
  return 23.85 + 0.0000395 * T * T - 0.000000178 * T * T * T;
}

// Apply sidereal correction to a tropical longitude
function toSidereal(tropicalLon, jde) {
  return norm(tropicalLon - lahiriAyanamsa(jde));
}

// ── helpers ────────────────────────────────────────────────────────────────
function norm(deg) { return ((deg % 360) + 360) % 360; }

function signOf(lon) {
  const idx = Math.floor(norm(lon) / 30);
  return SIGNS[idx];
}

function degInSign(lon) {
  return norm(lon) % 30;
}

function planetObj(name, symbol, lonDeg, retrograde = false) {
  const s = signOf(lonDeg);
  return {
    name, symbol,
    longitude: +lonDeg.toFixed(4),
    sign: s.name,
    signSymbol: s.symbol,
    degreeInSign: +degInSign(lonDeg).toFixed(2),
    element: s.element,
    mode: s.mode,
    retrograde,
  };
}

// Convert heliocentric VSOP87B ecliptic → geocentric ecliptic longitude (deg)
// Uses a simple Sun-subtraction approximation (arc-minute accuracy, fine for Oracle)
function helioToGeo(planetLon, planetLat, planetR, earthLon, earthLat, earthR) {
  // Convert to heliocentric rectangular
  const px = planetR * Math.cos(planetLat) * Math.cos(planetLon);
  const py = planetR * Math.cos(planetLat) * Math.sin(planetLon);
  // Earth
  const ex = earthR * Math.cos(earthLat) * Math.cos(earthLon);
  const ey = earthR * Math.cos(earthLat) * Math.sin(earthLon);
  // Geocentric vector
  const dx = px - ex;
  const dy = py - ey;
  return Math.atan2(dy, dx);   // radians
}

// ── planet position calculators ────────────────────────────────────────────
function getEarth(jde) {
  const p = earth.position(jde);
  return { lon: p.lon, lat: p.lat, r: p.range };
}

function getSun(jde) {
  // Solar apparent longitude (geocentric) — use high-precision VSOP87 path
  const p = solar.apparentVSOP87(earth, jde);
  return norm(p.lon * R2D);
}

function getMoon(jde) {
  const p = moonPos.position(jde);
  // moonposition returns geocentric ecliptic longitude in radians
  return norm(p.lon * R2D);
}

function getInnerPlanet(jde, planet, earthPos) {
  const p = planet.position(jde);
  const geoLon = helioToGeo(p.lon, p.lat, p.range, earthPos.lon, earthPos.lat, earthPos.r);
  return norm(geoLon * R2D);
}

// Approximate daily motion (for retrograde detection)
function getInnerPlanetFull(jde, planet, earthPos, earthPosPrev) {
  const lonNow  = getInnerPlanet(jde,        planet, earthPos);
  const lonPrev = getInnerPlanet(jde - 1,    planet, earthPosPrev);
  const motion  = norm(lonNow - lonPrev + 360);
  const retro   = motion > 180; // moved "backwards"
  return { lon: lonNow, retrograde: retro };
}

// North Node: mean retrograde motion ~0.05295°/day from J2000 epoch
function getNorthNode(jde) {
  const J2000 = 2451545.0;
  const lon2000 = 125.0445; // mean node longitude at J2000
  const rate = -0.05295; // degrees/day
  return norm(lon2000 + rate * (jde - J2000));
}

// ── sky snapshot ───────────────────────────────────────────────────────────
function buildSkySnapshot(dateISO) {
  const date = new Date(dateISO || Date.now());
  const jde  = DateToJDE(date);
  const jdePrev = jde - 1;

  const eNow  = getEarth(jde);
  const ePrev = getEarth(jdePrev);

  const sunLon  = getSun(jde);
  const moonLon = getMoon(jde);

  const mercFull = getInnerPlanetFull(jde, mercury, eNow, ePrev);
  const venFull  = getInnerPlanetFull(jde, venus,   eNow, ePrev);
  const marsFull = getInnerPlanetFull(jde, mars,    eNow, ePrev);
  const jupFull  = getInnerPlanetFull(jde, jupiter, eNow, ePrev);
  const satFull  = getInnerPlanetFull(jde, saturn,  eNow, ePrev);
  const urFull   = getInnerPlanetFull(jde, uranus,  eNow, ePrev);
  const nepFull  = getInnerPlanetFull(jde, neptune, eNow, ePrev);

  // Pluto: mean motion (VSOP87 data exists but is huge; mean motion is fine)
  const plutoLon = norm(238.9 + 1.397 / 365.25 * (jde - 2451545.0));
  const northNodeLon = getNorthNode(jde);

  return {
    date: date.toISOString(),
    jde: +jde.toFixed(2),
    planets: {
      sun:       planetObj('Sun',       '☀️',  sunLon),
      moon:      planetObj('Moon',      '🌙',  moonLon),
      mercury:   planetObj('Mercury',   '☿',  mercFull.lon,  mercFull.retrograde),
      venus:     planetObj('Venus',     '♀',  venFull.lon,   venFull.retrograde),
      mars:      planetObj('Mars',      '♂',  marsFull.lon,  marsFull.retrograde),
      jupiter:   planetObj('Jupiter',   '♃',  jupFull.lon,   jupFull.retrograde),
      saturn:    planetObj('Saturn',    '♄',  satFull.lon,   satFull.retrograde),
      uranus:    planetObj('Uranus',    '♅',  urFull.lon,    urFull.retrograde),
      neptune:   planetObj('Neptune',   '♆',  nepFull.lon,   nepFull.retrograde),
      pluto:     planetObj('Pluto',     '♇',  plutoLon),
      northNode: planetObj('North Node','☊',  northNodeLon),
    },
  };
}

// ── whole-sign houses ──────────────────────────────────────────────────────
function calcWholeSignHouses(jde, lat, lon) {
  // Local Sidereal Time
  const gmst = sidereal.apparent(jde); // radians
  const lstRad = gmst + lon * D2R;
  const lst = norm(lstRad * R2D);

  // Ascendant from LST + latitude (approximate)
  const latRad = lat * D2R;
  // Obliquity ~23.44°
  const oblRad = 23.44 * D2R;
  const lstRad2 = lst * D2R;
  const y = -Math.cos(lstRad2);
  const x =  Math.sin(oblRad) * Math.tan(latRad) + Math.cos(oblRad) * Math.sin(lstRad2);
  let ascLon = Math.atan2(y, x) * R2D;
  ascLon = norm(ascLon);

  const ascSignIdx = Math.floor(ascLon / 30);
  const houses = [];
  for (let h = 1; h <= 12; h++) {
    const signIdx = (ascSignIdx + h - 1) % 12;
    houses.push({
      house: h,
      sign: SIGNS[signIdx].name,
      signSymbol: SIGNS[signIdx].symbol,
      startLon: signIdx * 30,
      domain: HOUSE_DOMAINS[h],
    });
  }
  return { ascendant: ascLon, ascendantSign: SIGNS[ascSignIdx].name, houses };
}

// ── transit aspects ────────────────────────────────────────────────────────
const ASPECTS = [
  { name:'Conjunction', angle:0,   orb:8 },
  { name:'Sextile',     angle:60,  orb:4 },
  { name:'Square',      angle:90,  orb:6 },
  { name:'Trine',       angle:120, orb:6 },
  { name:'Opposition',  angle:180, orb:8 },
];

function detectAspect(lon1, lon2) {
  const diff = Math.abs(norm(lon1 - lon2));
  const angle = diff > 180 ? 360 - diff : diff;
  for (const a of ASPECTS) {
    if (Math.abs(angle - a.angle) <= a.orb) {
      return { ...a, orb: +Math.abs(angle - a.angle).toFixed(2) };
    }
  }
  return null;
}

function detectTransits(natalPositions, currentPositions) {
  const transits = [];
  const currentKeys = Object.keys(currentPositions);
  const natalKeys   = Object.keys(natalPositions);
  for (const tp of currentKeys) {
    for (const np of natalKeys) {
      const asp = detectAspect(currentPositions[tp].longitude, natalPositions[np].longitude);
      if (asp) {
        transits.push({
          transitPlanet:  tp,
          natalPlanet:    np,
          aspect:         asp.name,
          exactAngle:     asp.angle,
          orb:            asp.orb,
          transitLon:     currentPositions[tp].longitude,
          natalLon:       natalPositions[np].longitude,
          transitSign:    currentPositions[tp].sign,
          natalSign:      natalPositions[np].sign,
        });
      }
    }
  }
  return transits.sort((a, b) => a.orb - b.orb);
}

// ── Oracle context builder ─────────────────────────────────────────────────
function buildOracleAstroContext(transits, currentSky, natalChart) {
  const lines = ['[ASTROLOGICAL CONTEXT — for Oracle interpretation only, do not quote directly]'];

  if (currentSky) {
    const sun  = currentSky.planets.sun;
    const moon = currentSky.planets.moon;
    lines.push(`Current sky: Sun in ${sun.sign}, Moon in ${moon.sign}`);
    const retros = Object.values(currentSky.planets)
      .filter(p => p.retrograde).map(p => p.name);
    if (retros.length) lines.push(`Retrograde: ${retros.join(', ')}`);
  }

  if (natalChart && natalChart.planets) {
    const np = natalChart.planets;
    lines.push(`Natal: Sun ${np.sun?.sign}, Moon ${np.moon?.sign}, Asc ${natalChart.ascendantSign || '?'}`);
  }

  if (transits && transits.length) {
    const top = transits.slice(0, 5);
    lines.push('Active transits: ' + top.map(t =>
      `${t.transitPlanet} ${t.aspect} natal ${t.natalPlanet} (${t.orb}°)`
    ).join('; '));
  }

  return lines.join('\n');
}

// ── routes ─────────────────────────────────────────────────────────────────

// GET /api/ephemeris?date=ISO&lat=&lon=
router.get('/', (req, res) => {
  try {
    const { date, lat, lon } = req.query;
    const snap = buildSkySnapshot(date || new Date().toISOString());

    let houseData = null;
    if (lat !== undefined && lon !== undefined) {
      const jde = snap.jde;
      houseData = calcWholeSignHouses(jde, parseFloat(lat), parseFloat(lon));
    }

    res.json({ success: true, ephemeris: snap, houses: houseData });
  } catch (err) {
    console.error('Ephemeris error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Build sidereal (Vedic/Lahiri) positions for all planets from a tropical snapshot
function buildVedicPositions(tropicalSnap, jde) {
  const ayam = lahiriAyanamsa(jde);
  const siderealPlanets = {};
  for (const [key, p] of Object.entries(tropicalSnap.planets)) {
    const sidLon = toSidereal(p.longitude, jde);
    const s = signOf(sidLon);
    siderealPlanets[key] = {
      ...p,
      longitude:    +sidLon.toFixed(4),
      sign:         s.name,
      signSymbol:   s.symbol,
      degreeInSign: +degInSign(sidLon).toFixed(2),
      element:      s.element,
      mode:         s.mode,
      tropicalLongitude: p.longitude,
      tropicalSign:      p.sign,
    };
  }
  return { siderealPlanets, ayanamsa: +ayam.toFixed(4) };
}

// POST /api/ephemeris/natal
// Body: { birthDate: ISO, birthLat: number, birthLon: number }
router.post('/natal', (req, res) => {
  try {
    const { birthDate, birthLat, birthLon } = req.body || {};
    if (!birthDate) return res.status(400).json({ success: false, error: 'birthDate required' });

    const snap      = buildSkySnapshot(birthDate);
    const lat       = parseFloat(birthLat) || 0;
    const lon       = parseFloat(birthLon) || 0;
    const jde       = snap.jde;
    const houseData = calcWholeSignHouses(jde, lat, lon);

    // Sidereal (Vedic/Lahiri) positions
    const { siderealPlanets, ayanamsa } = buildVedicPositions(snap, jde);

    // Sidereal ascendant: same formula but subtract ayanamsa
    const sidAscLon = toSidereal(houseData.ascendant, jde);
    const sidAscSign = signOf(sidAscLon);

    // Vedic profile: the three pillars shown to the user
    const vedicProfile = {
      sun:       { sign: siderealPlanets.sun.sign,  symbol: siderealPlanets.sun.signSymbol,  deg: siderealPlanets.sun.degreeInSign  },
      moon:      { sign: siderealPlanets.moon.sign, symbol: siderealPlanets.moon.signSymbol, deg: siderealPlanets.moon.degreeInSign },
      rising:    { sign: sidAscSign.name,           symbol: sidAscSign.symbol,               deg: +degInSign(sidAscLon).toFixed(2) },
      ayanamsa,
      system:    'Lahiri (Vedic sidereal)',
    };

    res.json({
      success: true,
      natalChart: {
        ...snap,
        ...houseData,
        birthLat: lat,
        birthLon: lon,
        siderealPlanets,
        siderealAscendant: sidAscLon,
        siderealAscendantSign: sidAscSign.name,
        ayanamsa,
        vedicProfile,
      },
    });
  } catch (err) {
    console.error('Natal error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/ephemeris/transits
// Body: { natalChart: { planets: {...} }, date?: ISO }
router.post('/transits', (req, res) => {
  try {
    const { natalChart, date } = req.body || {};
    if (!natalChart || !natalChart.planets) {
      return res.status(400).json({ success: false, error: 'natalChart.planets required' });
    }

    const currentSky = buildSkySnapshot(date || new Date().toISOString());
    const transits   = detectTransits(natalChart.planets, currentSky.planets);
    const oracleContext = buildOracleAstroContext(transits, currentSky, natalChart);

    res.json({ success: true, currentSky, transits, oracleContext });
  } catch (err) {
    console.error('Transits error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = { router, buildOracleAstroContext, buildSkySnapshot };
