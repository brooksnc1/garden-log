// Everything here is derived from stored records and events. Nothing in this
// file writes data, so the model can be changed freely in a future version and
// it will simply recompute from the same history.

import { crop, timingFor } from './crops.js';
import { localDate } from './weather.js';

export const DUE_FRACTION = 0.4;      // water when available water drops below 40%
const AWC_PER_GAL = 0.22;             // plant-available water per gallon of potting mix
const BARE_SOIL = 0.6;                // evaporation from bare, moist potting mix
const FALLBACK_ET0_MM = 3;            // used if a day of weather is missing
const FROZEN_MAX_F = 34;              // days this cold: no water use, feeding paused
const MOISTURE_LEVELS = { dry: 0.15, moist: 0.55, wet: 1.0 };

export const BUCKET_PRESET = { soilGal: 4.5, diameterIn: 11.9, sizeLabel: '5-gallon bucket' };

// ---------- dates ----------
export function addDays(date, n) {
  const d = new Date(date + 'T12:00');
  d.setDate(d.getDate() + n);
  return localDate(d);
}
export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00') - new Date(a + 'T12:00')) / 864e5);
}
export function eventDay(e) { return localDate(new Date(e.at)); }
function hourFrac(iso) {
  const d = new Date(iso);
  return (d.getHours() + d.getMinutes() / 60) / 24;
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------- container geometry ----------
export function openingAreaSqIn(c) {
  const d = Number(c.diameterIn) || BUCKET_PRESET.diameterIn;
  return Math.PI * (d / 2) ** 2;
}
export function awcGal(c) {
  return (Number(c.soilGal) || BUCKET_PRESET.soilGal) * AWC_PER_GAL;
}
// Daylight hours from sunrise/sunset. Uses Open-Meteo's value when stored,
// otherwise the standard astronomical formula (sun center 0.833° below the
// horizon, accounting for refraction), which agrees within a few minutes.
export function daylightHours(day, w, lat) {
  if (w && typeof w.daylightH === 'number') return w.daylightH;
  const phi = ((lat ?? 40) * Math.PI) / 180;
  const d = new Date(day + 'T12:00');
  const n = Math.round((d - new Date(d.getFullYear(), 0, 0)) / 864e5);
  const decl = (23.44 * Math.PI / 180) * Math.sin((2 * Math.PI * (284 + n)) / 365);
  const cosW = (Math.sin(-0.833 * Math.PI / 180) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl));
  return (2 * Math.acos(clamp(cosW, -1, 1)) * 180 / Math.PI) / 15;
}

// Reference evapotranspiration already reflects day length and clouds for a
// fully sunlit surface, so an unshaded container gets factor 1. Shade removes
// direct sun for part of the day; diffuse sky light (~35%) remains.
export function sunInfo(c, day, w, lat) {
  const daylight = daylightHours(day, w, lat);
  const shade = clamp(Number(c.shadeHours) || 0, 0, daylight);
  return { daylight, shade, sunHours: daylight - shade, factor: 1 - 0.65 * (shade / daylight) };
}

export function activePlantingsOn(containerId, day, plantings) {
  return plantings.filter((p) => !p.deletedAt && p.containerId === containerId
    && p.plantedDate <= day && (!p.endDate || p.endDate > day));
}

function canopyFactor(c, day, plantings) {
  const act = activePlantingsOn(c.id, day, plantings);
  if (!act.length) return BARE_SOIL;
  const fs = act.map((p) => {
    const t = timingFor(p);
    const mid = t.dtmMin && t.dtmMax ? (t.dtmMin + t.dtmMax) / 2 : 60;
    const growth = clamp(daysBetween(p.plantedDate, day) / mid, 0.1, 1);
    return crop(p.crop).canopy * growth;
  });
  const top = Math.max(...fs);
  return Math.max(BARE_SOIL, Math.min(top + 0.15 * (fs.length - 1), top * 1.3));
}

function dayFlux(c, day, w, plantings, lat) {
  const area = openingAreaSqIn(c);
  const rainIn = (w ? w.rainMm || 0 : 0) / 25.4;
  const et0In = (w ? w.et0Mm : FALLBACK_ET0_MM) / 25.4;
  const frozen = !!(w && w.tmaxF <= FROZEN_MAX_F);
  const etBase = frozen ? 0 : (et0In * area * canopyFactor(c, day, plantings) * sunInfo(c, day, w, lat).factor) / 231;
  return { rainGal: (rainIn * area) / 231, rainIn, etBase, frozen, estimated: !w };
}

// ---------- water balance ----------
export function simulate(c, ctx) {
  const { plantings, events, weather, today, nowFrac, lat } = ctx;
  const awc = awcGal(c);
  const evs = events
    .filter((e) => !e.deletedAt && e.containerId === c.id && (e.type === 'water' || e.type === 'moisture'))
    .map((e) => ({ ...e, day: eventDay(e), h: hourFrac(e.at) }))
    .filter((e) => e.day <= today)
    .sort((a, b) => a.at.localeCompare(b.at));

  // Start at the earliest of: container added, first planting, first event
  // Weather is kept locally, so history accumulates; cap at two years for speed.
  let start = localDate(new Date(c.createdAt));
  const firstPlant = plantings.filter((p) => p.containerId === c.id).map((p) => p.plantedDate).sort()[0];
  if (firstPlant && firstPlant < start) start = firstPlant;
  if (evs.length && evs[0].day < start) start = evs[0].day;
  const floor = addDays(today, -730);
  if (start < floor) start = floor;

  let frac = 0.8;
  let calib = 1;
  const series = [];
  let estimatedDays = 0;

  for (let d = start; d <= today; d = addDays(d, 1)) {
    const f = dayFlux(c, d, weather.get(d), plantings, lat);
    if (f.estimated) estimatedDays++;
    const end = d === today ? nowFrac : 1;
    let t = 0;
    const step = (p) => {
      if (p > 0) frac = clamp(frac + (f.rainGal * p - f.etBase * calib * p) / awc, 0, 1);
    };
    for (const e of evs) {
      if (e.day !== d) continue;
      const h = Math.min(e.h, end);
      step(h - t);
      t = Math.max(t, h);
      if (e.type === 'water') {
        const amt = Number(e.data?.amountGal);
        frac = amt > 0 ? Math.min(1, frac + amt / awc) : 1;
      } else if (e.type === 'moisture') {
        const obs = MOISTURE_LEVELS[e.data?.level];
        if (obs !== undefined) {
          if (obs < frac - 0.25) calib = Math.min(2, calib * 1.15);
          else if (obs > frac + 0.25) calib = Math.max(0.5, calib / 1.15);
          frac = obs;
        }
      }
    }
    step(end - t);
    series.push({ date: d, frac, rainIn: f.rainIn, etGal: f.etBase * calib, frozen: f.frozen, estimated: f.estimated });
  }

  // Look ahead with forecast data to estimate the next watering.
  let proj = frac;
  let nextDue = frac < DUE_FRACTION ? today : null;
  const todayFlux = dayFlux(c, today, weather.get(today), plantings, lat);
  proj = clamp(proj + (todayFlux.rainGal - todayFlux.etBase * calib) * (1 - nowFrac) / awc, 0, 1);
  if (!nextDue && proj < DUE_FRACTION) nextDue = today;
  for (let i = 1; i <= 6 && !nextDue; i++) {
    const d = addDays(today, i);
    const w = weather.get(d);
    if (!w) break;
    const f = dayFlux(c, d, w, plantings, lat);
    proj = clamp(proj + (f.rainGal - f.etBase * calib) / awc, 0, 1);
    if (proj < DUE_FRACTION) nextDue = d;
  }

  const lastWater = [...evs].reverse().find((e) => e.type === 'water') || null;
  const tomorrow = weather.get(addDays(today, 1));
  return {
    frac, calib, series, nextDue, lastWater, estimatedDays, awc,
    usingToday: todayFlux.etBase * calib,
    frozenToday: todayFlux.frozen,
    rainTomorrowIn: tomorrow && tomorrow.kind === 'forecast' ? (tomorrow.rainMm || 0) / 25.4 : 0,
  };
}

export function containerStatus(c, ctx) {
  const sim = simulate(c, ctx);
  const active = activePlantingsOn(c.id, ctx.today, ctx.plantings);
  let status = 'ok';
  if (!active.length) status = 'idle';
  else if (sim.frozenToday) status = 'frozen';
  else if (sim.frac < DUE_FRACTION) status = 'due';
  const rainCanWait = status === 'due' && sim.frac >= 0.15 && sim.rainTomorrowIn >= 0.2;
  return { ...sim, status, rainCanWait, active };
}

// ---------- feeding ----------
export function fertilizeStatus(c, ctx) {
  const every = Number(c.fertilizeDays);
  if (!every) return null;
  const active = activePlantingsOn(c.id, ctx.today, ctx.plantings);
  if (!active.length) return null;
  const last = ctx.events
    .filter((e) => !e.deletedAt && e.containerId === c.id && e.type === 'fertilize')
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const ref = last ? eventDay(last) : active.map((p) => p.plantedDate).sort()[0];
  const dueOn = addDays(ref, every);
  const temps = [];
  for (let i = 0; i < 7; i++) {
    const w = ctx.weather.get(addDays(ctx.today, -i));
    if (w) temps.push(w.tmaxF);
  }
  const cold = temps.length >= 4 && temps.reduce((a, b) => a + b, 0) / temps.length < 50;
  return { dueOn, due: ctx.today >= dueOn, cold, last };
}

// ---------- planting timing ----------
function isFallPlanting(date, lat) {
  const m = new Date(date + 'T12:00').getMonth();
  return (lat ?? 40) >= 0 ? m >= 7 && m <= 10 : m >= 1 && m <= 4;
}

export function plantingInfo(p, ctx) {
  const c = crop(p.crop);
  const t = timingFor(p);
  const evs = ctx.events.filter((e) => !e.deletedAt && e.plantingId === p.id)
    .sort((a, b) => a.at.localeCompare(b.at));
  const sprouted = evs.find((e) => e.type === 'sprouted');
  const thinned = evs.find((e) => e.type === 'thinned');
  const harvests = evs.filter((e) => e.type === 'harvest');
  const pd = p.plantedDate;
  const fall = !c.overwinter && isFallPlanting(pd, ctx.lat) ? 14 : 0;

  const germ = p.method === 'seed' && t.germMin != null && t.germMax != null
    ? { from: addDays(pd, t.germMin), to: addDays(pd, t.germMax) } : null;
  const needsThin = p.method === 'seed' && (p.thin ?? c.thin);
  const thin = needsThin && sprouted
    ? { from: addDays(eventDay(sprouted), 7), to: addDays(eventDay(sprouted), 14), done: !!thinned } : null;
  const harvest = t.dtmMin != null && t.dtmMax != null
    ? { from: addDays(pd, t.dtmMin + fall), to: addDays(pd, t.dtmMax + fall), fall } : null;

  let phase = 'growing';
  if (p.status && p.status !== 'active') phase = 'finished';
  else if (harvests.length) phase = 'harvesting';
  else if (harvest && ctx.today >= harvest.from) phase = 'ready';
  else if (germ && !sprouted) phase = 'sprouting';

  const sproutCount = Number(sprouted?.data?.count);
  const germRate = sproutCount && Number(p.count) ? sproutCount / Number(p.count) : null;
  const firstHarvest = harvests[0] ? eventDay(harvests[0]) : null;
  let harvestOffset = null;
  if (firstHarvest && harvest) {
    if (firstHarvest < harvest.from) harvestOffset = daysBetween(harvest.from, firstHarvest);
    else if (firstHarvest > harvest.to) harvestOffset = daysBetween(harvest.to, firstHarvest);
    else harvestOffset = 0;
  }
  return { crop: c, timing: t, germ, thin, needsThin, harvest, phase, sprouted, thinned, harvests, germRate, firstHarvest, harvestOffset, events: evs };
}

// ---------- alerts from the forecast ----------
export function weatherAlerts(ctx) {
  const out = [];
  for (const c of ctx.containers) {
    if (c.deletedAt) continue;
    const act = activePlantingsOn(c.id, ctx.today, ctx.plantings);
    if (!act.length) continue;
    // Most cold-sensitive crop in the container; +3°F because pot roots
    // aren't insulated by ground.
    const tender = act.reduce((best, p) => (crop(p.crop).minTempF > crop(best.crop).minTempF ? p : best));
    const limit = crop(tender.crop).minTempF + 3;
    for (let i = 0; i <= 3; i++) {
      const d = addDays(ctx.today, i);
      const w = ctx.weather.get(d);
      if (!w) continue;
      if (w.tminF <= limit) {
        out.push({ kind: 'cold', containerId: c.id, date: d, temp: Math.round(w.tminF), crop: crop(tender.crop).name, container: c.name });
        break;
      }
    }
    for (let i = 0; i <= 3; i++) {
      const d = addDays(ctx.today, i);
      const w = ctx.weather.get(d);
      if (w && w.tmaxF >= 95) {
        out.push({ kind: 'heat', containerId: c.id, date: d, temp: Math.round(w.tmaxF), container: c.name });
        break;
      }
    }
  }
  return out;
}

// ---------- season summary ----------
export function seasonSummary(year, ctx) {
  const harvests = ctx.events.filter((e) => !e.deletedAt && e.type === 'harvest' && eventDay(e).startsWith(String(year)));
  const totals = new Map();
  for (const e of harvests) {
    const p = ctx.plantings.find((x) => x.id === e.plantingId);
    const key = `${p ? p.crop : 'other'}|${e.data?.unit || 'count'}`;
    const cur = totals.get(key) || { crop: p ? crop(p.crop).name : 'Unknown', unit: e.data?.unit || 'count', amount: 0, pickings: 0 };
    cur.amount += Number(e.data?.amount) || 0;
    cur.pickings++;
    totals.set(key, cur);
  }
  const plantings = ctx.plantings.filter((p) => !p.deletedAt && p.plantedDate.startsWith(String(year)))
    .map((p) => ({ p, info: plantingInfo(p, ctx) }));
  return { totals: [...totals.values()].sort((a, b) => b.pickings - a.pickings), plantings };
}
