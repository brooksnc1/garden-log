import * as db from './db.js';
import { CROPS, UNITS, METHODS, crop, timingFor } from './crops.js';
import * as M from './model.js';
import { fetchWeather, weatherIsStale, getPosition, localDate } from './weather.js';
import { savePhoto, photoURL } from './photos.js';

// Bump together with VERSION in sw.js on every release.
export const APP_VERSION = '1.0.0';

const S = {
  containers: [], plantings: [], events: [], seeds: [],
  weather: new Map(), settings: {}, lastBackupAt: null, installedAt: null,
  weatherFetchedAt: null, weatherError: null, migration: null, journalFilter: 'all',
};
const view = document.getElementById('view');
const sheetEl = document.getElementById('sheet');

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const live = (arr) => arr.filter((r) => !r.deletedAt);
const byId = (arr, id) => arr.find((r) => r.id === id);
const today = () => localDate();
function nowLocalInput(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(date, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(date + 'T12:00').toLocaleDateString(undefined, opts);
}
const fmtShort = (d) => fmtDate(d, { month: 'short', day: 'numeric' });
function fmtTime(iso) { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
function relDay(date) {
  const n = M.daysBetween(today(), date);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1 && n < 7) return fmtDate(date, { weekday: 'long' });
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
function ctx() {
  const now = new Date();
  return {
    containers: live(S.containers), plantings: live(S.plantings), events: live(S.events),
    weather: S.weather, today: localDate(now), nowFrac: (now.getHours() + now.getMinutes() / 60) / 24,
    lat: S.settings.lat,
  };
}
function plantingLabel(p) {
  const c = crop(p.crop);
  return p.variety ? `${c.name}, ${p.variety}` : c.name;
}
function toast(msg, undo) {
  const t = document.getElementById('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  if (undo) t.querySelector('button').onclick = async () => { t.hidden = true; await undo(); };
  toast.timer = setTimeout(() => { t.hidden = true; }, undo ? 6000 : 3000);
}

// ---------------------------------------------------------------- data
async function load() {
  S.containers = await db.getAll('containers');
  S.plantings = await db.getAll('plantings');
  S.events = await db.getAll('events');
  S.seeds = await db.getAll('seeds');
  S.weather = new Map((await db.getAll('weather')).map((w) => [w.date, w]));
  S.settings = (await db.getMeta('settings')) || {};
  S.lastBackupAt = await db.getMeta('lastBackupAt');
  S.installedAt = await db.getMeta('installedAt');
  S.weatherFetchedAt = await db.getMeta('weatherFetchedAt');
}

async function addEvent(type, fields) {
  return db.create('events', { type, at: new Date().toISOString(), data: {}, photoIds: [], ...fields });
}

async function refreshWeather(force = false) {
  const { lat, lon } = S.settings;
  if (lat === undefined || lat === null || !navigator.onLine) return;
  if (!force && !(await weatherIsStale())) return;
  try {
    const dates = [...S.weather.keys()].filter((d) => S.weather.get(d).kind === 'past').sort();
    await fetchWeather(lat, lon, dates[dates.length - 1]);
    S.weatherError = null;
  } catch (e) {
    S.weatherError = e.message;
  }
  await load();
  render();
}

// ---------------------------------------------------------------- gauge
function gauge(frac, status, size = 52) {
  const w = 44, h = 52;
  const f = Math.max(0, Math.min(1, frac ?? 0));
  const top = 10, bottom = 48, fillTop = bottom - (bottom - top) * f;
  const markY = bottom - (bottom - top) * M.DUE_FRACTION;
  const path = 'M4 10 L40 10 L36 48 L8 48 Z';
  const id = 'g' + Math.random().toString(36).slice(2, 8);
  return `<svg class="gauge ${status}" viewBox="0 0 ${w} ${h}" width="${size * w / h}" height="${size}" role="img" aria-label="${Math.round(f * 100)}% of usable water left">
    <defs><clipPath id="${id}"><path d="${path}"/></clipPath></defs>
    <path class="handle" d="M6 12 Q22 -2 38 12"/>
    <rect class="fill" clip-path="url(#${id})" x="0" y="${fillTop}" width="${w}" height="${bottom - fillTop}"/>
    <line class="mark" x1="6" x2="38" y1="${markY}" y2="${markY}"/>
    <path class="shell" d="${path}"/>
  </svg>`;
}

function statusLine(st) {
  switch (st.status) {
    case 'idle': return 'Nothing planted right now';
    case 'frozen': return 'Frozen today. No watering needed.';
    case 'due':
      return st.rainCanWait
        ? `Needs water, but about ${st.rainTomorrowIn.toFixed(2)} in of rain is forecast tomorrow. It can probably wait.`
        : '<span class="status-due">Needs water</span>';
    default:
      return st.nextDue ? `Next watering ${relDay(st.nextDue)}` : 'Moist. No watering expected in the next few days.';
  }
}

// ---------------------------------------------------------------- views
const routes = {
  today: viewToday, garden: viewGarden, container: viewContainer, planting: viewPlanting,
  journal: viewJournal, season: viewSeason, seeds: viewSeeds, seed: viewSeed,
  compost: viewCompost, settings: viewSettings,
};
const tabOf = { container: 'garden', planting: 'garden', season: 'journal', seed: 'seeds', settings: null };

function render() {
  const [name, id] = (location.hash.slice(1) || 'today').split('/');
  const fn = routes[name] || viewToday;
  view.innerHTML = fn(id);
  const tab = name in tabOf ? tabOf[name] : name;
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  hydratePhotos(view);
}
async function hydratePhotos(root) {
  for (const img of root.querySelectorAll('img[data-photo]')) {
    const url = await photoURL(img.dataset.photo, img.dataset.size || 'thumb');
    if (url) img.src = url;
  }
}

function dueItems(c) {
  const items = [];
  for (const k of live(S.containers)) {
    const st = M.containerStatus(k, c);
    if (st.status === 'due') {
      items.push({
        tone: 'water', title: `Water ${k.name}`,
        detail: st.rainCanWait ? `About ${st.rainTomorrowIn.toFixed(2)} in of rain is forecast tomorrow, so this can probably wait.` : `About ${Math.round(st.frac * 100)}% of usable water left.`,
        action: `<button class="btn small" data-act="quickWater" data-id="${k.id}">Watered</button>`,
      });
    }
    const fe = M.fertilizeStatus(k, c);
    if (fe && fe.due) {
      items.push({
        tone: 'feed', title: `Feed ${k.name}`,
        detail: fe.cold ? 'Due, but it\u2019s been cold. Plants use little fertilizer now, so skipping is fine.' : `Due since ${fmtShort(fe.dueOn)}.`,
        action: `<button class="btn small" data-act="formFeed" data-id="${k.id}">Fed</button>`,
      });
    }
  }
  for (const p of c.plantings.filter((x) => (x.status || 'active') === 'active')) {
    const info = M.plantingInfo(p, c);
    const where = byId(S.containers, p.containerId)?.name || '';
    const label = esc(plantingLabel(p));
    const link = `href="#planting/${p.id}"`;
    if (info.germ && !info.sprouted) {
      if (c.today > M.addDays(info.germ.to, 3)) {
        items.push({ tone: 'grow', title: `No sprouts yet: ${label}`, detail: `Expected by ${fmtShort(info.germ.to)}. Cold soil slows germination; consider resowing if nothing shows in another week.`, action: `<button class="btn small" data-act="formSprouted" data-id="${p.id}">Sprouted</button>`, link });
      } else if (c.today >= info.germ.from) {
        items.push({ tone: 'info', title: `Watch for sprouts: ${label}`, detail: `In ${esc(where)}. Expected ${fmtShort(info.germ.from)} to ${fmtShort(info.germ.to)}.`, action: `<button class="btn small" data-act="formSprouted" data-id="${p.id}">Sprouted</button>`, link });
      }
    }
    if (info.thin && !info.thin.done && c.today >= info.thin.from) {
      const sp = info.timing.spacing ? ` Final spacing: ${info.timing.spacing} in.` : '';
      items.push({ tone: 'grow', title: `Thin ${label}`, detail: `Once the first true leaves show.${sp}`, action: `<button class="btn small" data-act="formThinned" data-id="${p.id}">Thinned</button>`, link });
    }
    if (info.harvest && c.today >= info.harvest.from && !info.harvests.length) {
      const late = c.today > info.harvest.to;
      items.push({ tone: 'harvest', title: late ? `Past expected harvest: ${label}` : `Ready to harvest: ${label}`, detail: `Expected ${fmtShort(info.harvest.from)} to ${fmtShort(info.harvest.to)}.`, action: `<button class="btn small" data-act="formHarvest" data-id="${p.id}">Harvest</button>`, link });
    }
  }
  const hasData = S.events.length || S.plantings.length;
  const since = S.lastBackupAt || S.installedAt;
  if (hasData && since && M.daysBetween(localDate(new Date(since)), c.today) >= 30) {
    items.push({ tone: 'info', title: 'Back up your garden data', detail: S.lastBackupAt ? `Last backup ${relDay(localDate(new Date(S.lastBackupAt)))}.` : 'No backup yet. Your data lives only on this phone.', action: '<a class="btn small" href="#settings">Back up</a>' });
  }
  return items;
}

const ICON = {
  water: '<svg viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/></svg>',
  feed: '<svg viewBox="0 0 24 24"><path d="M7 21h10l1-11H6Z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/></svg>',
  harvest: '<svg viewBox="0 0 24 24"><path d="M5 11h14a7 7 0 0 1-14 0Z"/><path d="M12 11c0-3 1-5 4-6M12 11c-.5-2-2-3.5-4-4"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M5 19.5 6 15 16 5l3 3L9 18Z"/><path d="M14 7l3 3"/></svg>',
};

function viewToday() {
  const c = ctx();
  const containers = c.containers;
  let h = `<h1>${fmtDate(c.today, { weekday: 'long', month: 'long', day: 'numeric' })}</h1>`;

  if (S.migration?.newerData) {
    h += `<div class="alert"><div><strong>This data was saved by a newer version of the app.</strong> Reload to get the update before making changes.</div></div>`;
  }
  const w = S.weather.get(c.today);
  if (S.settings.lat === undefined || S.settings.lat === null) {
    h += `<div class="note-bar"><p><b>Set your location to use rain and weather.</b></p><p class="small">The watering estimate uses daily rainfall and evaporation for your spot.</p><div class="btn-row"><a class="btn primary small" href="#settings">Set location</a></div></div>`;
  } else if (w) {
    h += `<p class="lede">High ${Math.round(w.tmaxF)}°, low ${Math.round(w.tminF)}°${w.rainMm ? `, ${(w.rainMm / 25.4).toFixed(2)} in rain` : ', no rain'}.`
      + (S.weatherError ? ` <span class="small">Weather not updated: ${esc(S.weatherError)}</span>` : '') + '</p>';
  } else if (S.weatherError) {
    h += `<p class="lede">Weather not updated: ${esc(S.weatherError)}</p>`;
  }

  for (const a of M.weatherAlerts(c)) {
    h += a.kind === 'cold'
      ? `<div class="alert"><span class="dot alert"></span><div><strong>Cold ${relDay(a.date)}: low of ${a.temp}°F.</strong> ${esc(a.crop)} in ${esc(a.container)} could be damaged. Move it somewhere sheltered or cover it overnight.</div></div>`
      : `<div class="alert"><span class="dot alert"></span><div><strong>Hot ${relDay(a.date)}: high of ${a.temp}°F.</strong> ${esc(a.container)} may need water twice that day. Afternoon shade helps.</div></div>`;
  }

  if (!containers.length) {
    return h + `<div class="empty" style="margin-top:18px"><p>Add your first container to start.</p><p class="muted">Each container keeps its own water estimate, feeding schedule and plantings.</p>
      <div class="btn-row"><button class="btn primary" data-act="formContainer" data-preset="bucket">Add a 5-gallon bucket</button><button class="btn" data-act="formContainer">Other container</button></div></div>`;
  }

  h += `<div class="quick">
    <button class="q-water" data-act="quickWater">${ICON.water}Watered</button>
    <button class="q-feed" data-act="formFeed">${ICON.feed}Fed</button>
    <button class="q-harvest" data-act="formHarvest">${ICON.harvest}Harvest</button>
    <button class="q-note" data-act="formNote">${ICON.note}Note</button>
  </div>`;

  const items = dueItems(c);
  h += '<h2>Due</h2>';
  h += items.length
    ? `<div class="panel due">${items.map((i) => `<div class="row"><span class="dot ${i.tone}"></span><div class="grow"><div class="title">${i.link ? `<a ${i.link} class="plain">${i.title}</a>` : i.title}</div><div class="sub">${i.detail}</div></div><div class="end">${i.action || ''}</div></div>`).join('')}</div>`
    : '<div class="empty"><p>Nothing due today.</p><p class="muted">Log a watering or a note any time from the buttons above.</p></div>';

  h += '<h2>Containers</h2><div class="panel">';
  for (const k of containers) {
    const st = M.containerStatus(k, c);
    h += `<a class="row" href="#container/${k.id}">${gauge(st.frac, st.status, 46)}<div class="grow"><div class="title">${esc(k.name)}</div><div class="sub">${statusLine(st)}</div></div></a>`;
  }
  return h + '</div>';
}

function viewGarden() {
  const c = ctx();
  let h = '<div class="head-row"><h1>Garden</h1><button class="btn small" data-act="formContainer">Add container</button></div>';
  if (!c.containers.length) {
    return h + `<div class="empty" style="margin-top:18px"><p>No containers yet.</p><div class="btn-row"><button class="btn primary" data-act="formContainer" data-preset="bucket">Add a 5-gallon bucket</button></div></div>`;
  }
  h += '<div class="stack" style="margin-top:16px">';
  for (const k of c.containers) {
    const st = M.containerStatus(k, c);
    const plants = c.plantings.filter((p) => p.containerId === k.id && (p.status || 'active') === 'active');
    h += `<div class="panel"><a class="row" href="#container/${k.id}">${gauge(st.frac, st.status, 56)}<div class="grow"><div class="title">${esc(k.name)}</div><div class="sub">${statusLine(st)}</div>
      <div class="chips">${plants.map((p) => `<span class="chip">${esc(plantingLabel(p))}</span>`).join('') || '<span class="chip past">Empty</span>'}</div></div></a></div>`;
  }
  return h + '</div>';
}

function chart(series) {
  const days = series.slice(-14);
  if (days.length < 2) return '<p class="muted small">The chart fills in after a couple of days.</p>';
  const W = 560, H = 150, pad = 18, top = 10, base = 118;
  const x = (i) => pad + (i * (W - 2 * pad)) / (days.length - 1);
  const y = (f) => base - (base - top) * f;
  const maxRain = Math.max(0.5, ...days.map((d) => d.rainIn));
  let bars = '', est = '';
  const bw = (W - 2 * pad) / days.length * 0.5;
  days.forEach((d, i) => {
    if (d.rainIn > 0.01) {
      const bh = (d.rainIn / maxRain) * 40;
      bars += `<rect class="rain" x="${x(i) - bw / 2}" y="${base - bh}" width="${bw}" height="${bh}"><title>${d.rainIn.toFixed(2)} in rain</title></rect>`;
    }
    if (d.estimated) est += `<rect class="est" x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${base - top}"/>`;
  });
  const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.frac).toFixed(1)}`).join(' ');
  const labels = [0, Math.floor(days.length / 2), days.length - 1]
    .map((i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${fmtShort(days[i].date)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated soil water over the last ${days.length} days">
    ${est}${bars}<line class="thresh" x1="${pad}" x2="${W - pad}" y1="${y(M.DUE_FRACTION)}" y2="${y(M.DUE_FRACTION)}"/>
    <path class="line" d="${line}"/>${labels}</svg>
    <p class="small muted">Line: estimated usable water. Bars: rain. Dashed: watering point.${days.some((d) => d.estimated) ? ' Gray: days without weather data, estimated.' : ''}</p>`;
}

function viewContainer(id) {
  const k = byId(S.containers, id);
  if (!k || k.deletedAt) return '<p>Container not found.</p><a href="#garden">Back to garden</a>';
  const c = ctx();
  const st = M.containerStatus(k, c);
  const fe = M.fertilizeStatus(k, c);
  const plants = c.plantings.filter((p) => p.containerId === k.id);
  const activeP = plants.filter((p) => (p.status || 'active') === 'active');
  const pastP = plants.filter((p) => (p.status || 'active') !== 'active');
  const soilEvents = c.events.filter((e) => e.containerId === k.id && (e.type === 'soil' || e.type === 'fertilize'))
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);

  let h = `<a class="back" href="#garden">Garden</a><div class="head-row"><h1>${esc(k.name)}</h1><button class="btn small" data-act="formContainer" data-id="${k.id}">Edit</button></div>`;
  h += `<div class="hero">${gauge(st.frac, st.status, 120)}<div><div class="pct">${Math.round(st.frac * 100)}%<small>usable water</small></div><p>${statusLine(st)}</p>
    ${st.lastWater ? `<p class="small muted">Last watered ${relDay(M.eventDay(st.lastWater))}, ${fmtTime(st.lastWater.at)}</p>` : ''}</div></div>`;
  h += `<div class="btn-row"><button class="btn primary" data-act="quickWater" data-id="${k.id}">Watered</button>
    <button class="btn" data-act="formMoisture" data-id="${k.id}">Soil check</button>
    <button class="btn" data-act="formFeed" data-id="${k.id}">Fed</button>
    <button class="btn" data-act="formSoil" data-id="${k.id}">Soil or compost</button></div>
    <button class="link-btn" data-act="formWater" data-id="${k.id}">Log watering with amount or time</button>`;

  h += '<h2>Last two weeks</h2>' + chart(st.series);

  h += `<div class="head-row"><h2>Growing now</h2><button class="btn small" data-act="formPlanting" data-container="${k.id}" style="margin-top:1.5rem">Add planting</button></div>`;
  h += activeP.length
    ? `<div class="panel">${activeP.map((p) => plantingRow(p, c)).join('')}</div>`
    : '<div class="empty"><p>Nothing planted.</p><p class="muted">Add a planting to start timing windows and water estimates.</p></div>';

  h += '<h2>Feeding and soil</h2>';
  if (fe) h += `<p>${fe.due ? '<span class="status-due">Feeding due</span>' : `Next feeding ${relDay(fe.dueOn)}`}${fe.cold ? ' (paused while it\u2019s cold)' : ''}. Every ${k.fertilizeDays} days.</p>`;
  else h += `<p class="muted">${Number(k.fertilizeDays) ? 'Feeding reminders start when something is planted.' : 'Feeding reminders are off. Turn them on in Edit.'}</p>`;
  if (soilEvents.length) h += `<div class="panel">${soilEvents.map((e) => eventRow(e)).join('')}</div>`;

  if (pastP.length) h += `<h2>Grown here before</h2><div class="panel">${pastP.map((p) => plantingRow(p, c)).join('')}</div>`;

  h += `<details class="more"><summary>How the water estimate works here</summary>
    <dl class="facts">
      <dt>Potting mix</dt><dd>${esc(k.soilGal)} gal, holding about ${st.awc.toFixed(2)} gal usable water</dd>
      <dt>Opening</dt><dd>${esc(k.diameterIn)} in across, so 1 in of rain adds ${(M.openingAreaSqIn(k) / 231).toFixed(2)} gal</dd>
      <dt>Sun</dt><dd>${k.sunHours === '' || k.sunHours == null ? 'not set (6 h assumed)' : esc(k.sunHours) + ' h a day'}</dd>
      <dt>Using now</dt><dd>about ${st.usingToday.toFixed(2)} gal a day</dd>
      <dt>Tuning</dt><dd>${st.calib === 1 ? 'none yet' : `${st.calib > 1 ? 'dries' : 'holds water'} ${Math.abs(Math.round((st.calib - 1) * 100))}% ${st.calib > 1 ? 'faster' : 'longer'} than the base model`}</dd>
    </dl>
    <p class="small muted">Rain adds water over the opening; evaporation and plant use come from daily weather, scaled by sun hours and plant size. A watering fills it back up. Soil checks correct the estimate and tune it over time.</p></details>`;
  return h;
}

function plantingRow(p, c) {
  const info = M.plantingInfo(p, c);
  let sub = `${METHODS[p.method] || ''}, ${fmtShort(p.plantedDate)}`;
  if (info.phase === 'finished') sub = `${fmtShort(p.plantedDate)} to ${p.endDate ? fmtShort(p.endDate) : '?'}, ${esc(p.status)}`;
  else if (info.phase === 'sprouting' && info.germ) sub += `. Sprouts expected ${fmtShort(info.germ.from)} to ${fmtShort(info.germ.to)}`;
  else if (info.phase === 'ready') sub += '. Harvest window open';
  else if (info.phase === 'harvesting') sub += `. Harvesting (${info.harvests.length})`;
  else if (info.harvest) sub += `. Harvest ${fmtShort(info.harvest.from)} to ${fmtShort(info.harvest.to)}`;
  return `<a class="row" href="#planting/${p.id}"><div class="grow"><div class="title">${esc(plantingLabel(p))}</div><div class="sub">${sub}</div></div></a>`;
}

function viewPlanting(id) {
  const p = byId(S.plantings, id);
  if (!p || p.deletedAt) return '<p>Planting not found.</p><a href="#garden">Back to garden</a>';
  const c = ctx();
  const info = M.plantingInfo(p, c);
  const k = byId(S.containers, p.containerId);
  const active = (p.status || 'active') === 'active';
  const seed = p.seedId ? byId(S.seeds, p.seedId) : null;

  let h = `<a class="back" href="#container/${k?.id}">${esc(k?.name || 'Garden')}</a>
    <div class="head-row"><div><h1>${esc(crop(p.crop).name)}</h1>${p.variety ? `<p class="lede">${esc(p.variety)}</p>` : ''}</div>
    <button class="btn small" data-act="formPlanting" data-id="${p.id}">Edit</button></div>`;
  h += `<p class="small muted">${esc(METHODS[p.method])}${p.count ? `, ${esc(p.count)} ${p.method === 'seed' ? 'seeds' : p.method === 'clove' ? 'cloves' : 'plants'}` : ''}${seed ? `, from <a href="#seed/${seed.id}">${esc(seed.variety || crop(seed.crop).name)} packet</a>` : ''}. Timing from ${info.timing.fromPacket ? 'seed packet' : 'typical values'}.</p>`;

  if (active) {
    h += '<div class="btn-row">';
    if (info.germ && !info.sprouted) h += `<button class="btn primary" data-act="formSprouted" data-id="${p.id}">Sprouted</button>`;
    if (info.thin && !info.thin.done) h += `<button class="btn primary" data-act="formThinned" data-id="${p.id}">Thinned</button>`;
    h += `<button class="btn ${info.phase === 'ready' || info.phase === 'harvesting' ? 'primary' : ''}" data-act="formHarvest" data-id="${p.id}">Harvest</button>
      <button class="btn" data-act="formNote" data-planting="${p.id}">Note</button>
      <button class="btn" data-act="formFinish" data-id="${p.id}">Finished</button></div>`;
  }

  h += '<h2>Timeline</h2><ul class="timeline">';
  h += `<li class="done"><b>Planted</b><div class="when">${fmtDate(p.plantedDate)}</div></li>`;
  if (info.germ) {
    h += info.sprouted
      ? `<li class="done"><b>Sprouted</b><div class="when">${fmtDate(M.eventDay(info.sprouted))}, day ${M.daysBetween(p.plantedDate, M.eventDay(info.sprouted))}${info.germRate ? `, ${Math.round(info.germRate * 100)}% came up` : ''}. Expected day ${info.timing.germMin} to ${info.timing.germMax}.</div></li>`
      : `<li class="${c.today >= info.germ.from ? 'now' : ''}"><b>Sprouts expected</b><div class="when">${fmtShort(info.germ.from)} to ${fmtShort(info.germ.to)}</div></li>`;
  }
  if (info.needsThin && info.germ) {
    h += info.thinned
      ? `<li class="done"><b>Thinned</b><div class="when">${fmtDate(M.eventDay(info.thinned))}${info.thinned.data?.kept ? `, kept ${esc(info.thinned.data.kept)}` : ''}</div></li>`
      : `<li class="${info.thin && c.today >= info.thin.from ? 'now' : ''}"><b>Thin</b><div class="when">${info.thin ? `${fmtShort(info.thin.from)} to ${fmtShort(info.thin.to)}` : 'About 1 to 2 weeks after sprouting'}${info.timing.spacing ? `, to ${info.timing.spacing} in apart` : ''}</div></li>`;
  }
  if (info.harvest) {
    h += `<li class="${info.harvests.length ? 'done' : info.phase === 'ready' ? 'now' : ''}"><b>Harvest window</b><div class="when">${fmtShort(info.harvest.from)} to ${fmtShort(info.harvest.to)}${info.harvest.fall ? ', including 14 extra days because fall plantings grow slower' : ''}</div></li>`;
  } else {
    h += '<li><b>Harvest window</b><div class="when">Add days to maturity (Edit) to see a window.</div></li>';
  }
  if (info.firstHarvest) {
    const off = info.harvestOffset;
    h += `<li class="done"><b>First harvest</b><div class="when">${fmtDate(info.firstHarvest)}, ${off === 0 ? 'within the expected window' : off < 0 ? `${-off} days before the window` : `${off} days after the window`}</div></li>`;
  }
  if (!active) h += `<li class="done"><b>Finished</b><div class="when">${p.endDate ? fmtDate(p.endDate) : ''}, ${esc(p.status)}</div></li>`;
  h += '</ul>';

  if (info.harvests.length) {
    const tot = {};
    for (const e of info.harvests) { const u = e.data?.unit || 'count'; tot[u] = (tot[u] || 0) + (Number(e.data?.amount) || 0); }
    h += `<h2>Harvested</h2><p>${Object.entries(tot).map(([u, a]) => `${+a.toFixed(2)} ${u}`).join(', ')} over ${info.harvests.length} picking${info.harvests.length > 1 ? 's' : ''}</p>`;
  }
  const journal = [...info.events].reverse();
  if (journal.length) h += `<h2>Journal</h2><div class="panel">${journal.map((e) => eventRow(e)).join('')}</div>`;
  if (p.notes) h += `<h2>Notes</h2><p>${esc(p.notes)}</p>`;
  return h;
}

// ---- journal
const EVENT_LABEL = {
  water: 'Watered', fertilize: 'Fed', harvest: 'Harvested', note: 'Note', problem: 'Problem',
  sprouted: 'Sprouted', thinned: 'Thinned', moisture: 'Soil check', soil: 'Soil', finished: 'Finished',
};
const FILTERS = [
  ['all', 'All'], ['water', 'Water'], ['feed', 'Feeding and soil'], ['harvest', 'Harvests'],
  ['notes', 'Notes'], ['problem', 'Problems'], ['growth', 'Growth'],
];
const FILTER_TYPES = {
  water: ['water', 'moisture'], feed: ['fertilize', 'soil'], harvest: ['harvest'], notes: ['note'],
  problem: ['problem'], growth: ['sprouted', 'thinned', 'finished'],
};

function eventSummary(e) {
  const k = byId(S.containers, e.containerId);
  const p = e.plantingId ? byId(S.plantings, e.plantingId) : null;
  const where = p ? plantingLabel(p) : k ? k.name : '';
  const d = e.data || {};
  switch (e.type) {
    case 'water': return `Watered ${where}${d.amountGal ? `, ${d.amountGal} gal` : ''}`;
    case 'fertilize': return `Fed ${where}${d.product ? ` with ${d.product}` : ''}`;
    case 'harvest': return `Harvested ${where}${d.amount ? `: ${d.amount} ${d.unit || ''}` : ''}`;
    case 'sprouted': return `${where} sprouted${d.count ? ` (${d.count})` : ''}`;
    case 'thinned': return `Thinned ${where}${d.kept ? `, kept ${d.kept}` : ''}`;
    case 'moisture': return `Soil check in ${where}: ${d.level}`;
    case 'soil': return `${d.kind || 'Soil'} in ${where}`;
    case 'finished': return `${where} finished: ${d.outcome || ''}`;
    case 'problem': return `Problem: ${where}${d.resolved ? ' (resolved)' : ''}`;
    default: return where ? `Note on ${where}` : 'Note';
  }
}
function eventRow(e) {
  const d = e.data || {};
  const text = [d.text, d.action ? `Did: ${d.action}` : '', d.details].filter(Boolean).map(esc).join('<br>');
  const photos = (e.photoIds || []).map((pid) => `<img data-photo="${pid}" alt="Photo">`).join('');
  return `<button type="button" class="row" data-act="openEvent" data-id="${e.id}">
    <div class="grow"><div class="title">${esc(eventSummary(e))}</div><div class="sub">${fmtShort(M.eventDay(e))}, ${fmtTime(e.at)}</div>
    ${text ? `<div style="margin-top:4px">${text}</div>` : ''}${photos ? `<div class="thumbs">${photos}</div>` : ''}</div></button>`;
}

function viewJournal() {
  const f = S.journalFilter;
  let evs = live(S.events).sort((a, b) => b.at.localeCompare(a.at));
  if (f !== 'all') evs = evs.filter((e) => FILTER_TYPES[f].includes(e.type));
  let h = `<div class="head-row"><h1>Journal</h1><a class="btn small" href="#season">Season summary</a></div>
    <div class="filters" role="group" aria-label="Filter">${FILTERS.map(([k, l]) => `<button data-act="filter" data-f="${k}" aria-pressed="${f === k}">${l}</button>`).join('')}</div>`;
  if (!evs.length) return h + '<div class="empty"><p>No entries yet.</p><p class="muted">Waterings, harvests, notes and photos show up here.</p><div class="btn-row"><button class="btn primary" data-act="formNote">Add a note</button></div></div>';
  let day = null;
  let open = false;
  for (const e of evs.slice(0, 300)) {
    const d = M.eventDay(e);
    if (d !== day) {
      if (open) h += '</div>';
      h += `<div class="day-head">${fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div><div class="panel">`;
      open = true; day = d;
    }
    h += eventRow(e);
  }
  return h + (open ? '</div>' : '');
}

function viewSeason(yearArg) {
  const c = ctx();
  const years = new Set([new Date().getFullYear()]);
  live(S.events).forEach((e) => years.add(Number(M.eventDay(e).slice(0, 4))));
  live(S.plantings).forEach((p) => years.add(Number(p.plantedDate.slice(0, 4))));
  const year = Number(yearArg) || new Date().getFullYear();
  const s = M.seasonSummary(year, c);
  let h = `<a class="back" href="#journal">Journal</a><div class="head-row"><h1>${year} season</h1>
    <select aria-label="Year" data-act="year" style="min-height:40px;border-radius:10px;border:1px solid var(--line);background:var(--surface);padding:0 10px">${[...years].sort((a, b) => b - a).map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></div>`;
  h += '<h2>Harvest totals</h2>';
  h += s.totals.length
    ? `<div class="stat-grid">${s.totals.map((t) => `<div class="stat"><b>${+t.amount.toFixed(2)} ${esc(t.unit)}</b><span>${esc(t.crop)}, ${t.pickings} picking${t.pickings > 1 ? 's' : ''}</span></div>`).join('')}</div>`
    : '<p class="muted">No harvests logged this year yet.</p>';
  h += '<h2>Packet vs. what happened</h2>';
  if (!s.plantings.length) return h + '<p class="muted">No plantings this year yet.</p>';
  h += '<div class="panel">';
  for (const { p, info } of s.plantings) {
    const bits = [];
    if (info.sprouted) bits.push(`sprouted day ${M.daysBetween(p.plantedDate, M.eventDay(info.sprouted))} (expected ${info.timing.germMin} to ${info.timing.germMax})`);
    if (info.germRate) bits.push(`${Math.round(info.germRate * 100)}% germination`);
    if (info.firstHarvest) bits.push(`first harvest day ${M.daysBetween(p.plantedDate, info.firstHarvest)}${info.harvestOffset ? `, ${Math.abs(info.harvestOffset)} days ${info.harvestOffset < 0 ? 'early' : 'late'}` : ', on time'}`);
    h += `<a class="row" href="#planting/${p.id}"><div class="grow"><div class="title">${esc(plantingLabel(p))}</div><div class="sub">Planted ${fmtShort(p.plantedDate)}${bits.length ? '. ' + bits.join('; ') : ''}</div></div></a>`;
  }
  return h + '</div><p class="small muted">After a few seasons, these differences are your own local correction to the numbers on the packets.</p>';
}

// ---- seeds
function viewSeeds() {
  const seeds = live(S.seeds).sort((a, b) => crop(a.crop).name.localeCompare(crop(b.crop).name));
  let h = '<div class="head-row"><h1>Seed packets</h1><button class="btn small" data-act="formSeed">Add packet</button></div>';
  if (!seeds.length) return h + '<div class="empty" style="margin-top:18px"><p>No packets yet.</p><p class="muted">Enter each packet once, with a photo of the back. Its germination and maturity days fill in automatically when you sow from it.</p></div>';
  const year = new Date().getFullYear();
  return h + `<div class="panel" style="margin-top:16px">${seeds.map((s) => {
    const age = s.packedFor ? year - Number(s.packedFor) : null;
    return `<a class="row" href="#seed/${s.id}">${s.photoId ? '<img data-photo="' + s.photoId + '" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px">' : ''}<div class="grow"><div class="title">${esc(crop(s.crop).name)}${s.variety ? `, ${esc(s.variety)}` : ''}</div>
      <div class="sub">${[s.source, s.packedFor ? `packed for ${s.packedFor}${age >= 3 ? ' (older seed, may sprout less)' : ''}` : '', s.quantity].filter(Boolean).map(esc).join(', ')}</div></div></a>`;
  }).join('')}</div>`;
}
function viewSeed(id) {
  const s = byId(S.seeds, id);
  if (!s || s.deletedAt) return '<p>Packet not found.</p><a href="#seeds">Back</a>';
  const used = live(S.plantings).filter((p) => p.seedId === s.id);
  const t = s.timing || {};
  let h = `<a class="back" href="#seeds">Seed packets</a><div class="head-row"><div><h1>${esc(crop(s.crop).name)}</h1>${s.variety ? `<p class="lede">${esc(s.variety)}</p>` : ''}</div><button class="btn small" data-act="formSeed" data-id="${s.id}">Edit</button></div>`;
  h += `<div class="btn-row"><button class="btn primary" data-act="formPlanting" data-seed="${s.id}">Sow from this packet</button></div>`;
  h += `<dl class="facts" style="margin-top:16px">
    ${s.source ? `<dt>Source</dt><dd>${esc(s.source)}</dd>` : ''}${s.packedFor ? `<dt>Packed for</dt><dd>${esc(s.packedFor)}</dd>` : ''}${s.quantity ? `<dt>Left</dt><dd>${esc(s.quantity)}</dd>` : ''}
    ${t.germMin || t.germMax ? `<dt>Germination</dt><dd>${esc(t.germMin)} to ${esc(t.germMax)} days</dd>` : ''}
    ${t.dtmMin || t.dtmMax ? `<dt>Maturity</dt><dd>${esc(t.dtmMin)} to ${esc(t.dtmMax)} days</dd>` : ''}
    ${t.spacing ? `<dt>Spacing</dt><dd>${esc(t.spacing)} in</dd>` : ''}</dl>`;
  if (s.notes) h += `<p>${esc(s.notes)}</p>`;
  if (s.photoId) h += `<img class="photo-full" data-photo="${s.photoId}" data-size="blob" alt="Seed packet photo">`;
  if (used.length) h += `<h2>Sown from this packet</h2><div class="panel">${used.map((p) => plantingRow(p, ctx())).join('')}</div>`;
  return h;
}

function viewCompost() {
  return '<h1>Compost</h1><div class="empty" style="margin-top:18px"><p>Nothing here yet.</p><p class="muted">This tab is set aside for compost records in a later version. Compost you add to a container can already be logged from that container, under Soil or compost.</p></div>';
}

function viewSettings() {
  const st = S.settings;
  let h = '<h1>Settings</h1>';
  h += `<h2>Location</h2><p class="muted small">Used only to fetch daily weather from Open-Meteo. Stored on this phone.</p>
    <p>${st.lat != null ? `${st.lat.toFixed(3)}, ${st.lon.toFixed(3)}` : 'Not set'}</p>
    <div class="btn-row"><button class="btn primary small" data-act="useLocation">Use my location</button><button class="btn small" data-act="formLocation">Enter coordinates</button>
    ${st.lat != null ? '<button class="btn small" data-act="refreshWeather">Refresh weather</button>' : ''}</div>
    <p class="small muted">${S.weatherFetchedAt ? `Weather updated ${relDay(localDate(new Date(S.weatherFetchedAt)))} at ${fmtTime(S.weatherFetchedAt)}.` : ''} ${S.weatherError ? esc(S.weatherError) : ''}</p>`;
  h += `<h2>Backup</h2><p class="muted small">Your data lives only on this phone. A backup file includes everything, photos too.</p>
    <p>${S.lastBackupAt ? `Last backup ${relDay(localDate(new Date(S.lastBackupAt)))}.` : 'No backup yet.'}</p>
    <div class="btn-row"><button class="btn primary small" data-act="exportBackup">Save backup file</button>
    ${navigator.canShare ? '<button class="btn small" data-act="shareBackup">Share backup (Drive, email)</button>' : ''}
    <label class="btn small">Restore from file<input type="file" accept="application/json,.json" data-act="importBackup" hidden></label></div>`;
  h += `<h2>Safety copies</h2><p class="muted small">Made automatically before every data upgrade or restore. The last five are kept.</p><div id="snaps" class="panel"><div class="row muted">Loading\u2026</div></div>`;
  h += `<h2>Storage</h2><div id="storage" class="muted small">Checking\u2026</div>`;
  h += `<h2>About</h2><p class="small muted">Garden Log ${APP_VERSION}, data version ${db.SCHEMA_VERSION}. Weather data by Open-Meteo.com.</p>`;
  queueMicrotask(fillSettingsAsync);
  return h;
}
async function fillSettingsAsync() {
  const snaps = await db.listSnapshots();
  const el = document.getElementById('snaps');
  if (el) {
    el.innerHTML = snaps.length
      ? snaps.map((s) => `<div class="row"><div class="grow"><div class="title">${fmtShort(localDate(new Date(s.createdAt)))}, ${fmtTime(s.createdAt)}</div><div class="sub">${esc(s.reason)}</div></div><button class="btn small" data-act="restoreSnap" data-id="${s.id}">Restore</button></div>`).join('')
      : '<div class="row muted">None yet.</div>';
  }
  const se = document.getElementById('storage');
  if (se && navigator.storage) {
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    se.innerHTML = `<p>${persisted ? 'Protected: the browser won\u2019t clear this data to free space.' : 'Not yet protected from automatic cleanup. Installing the app to your home screen usually fixes this.'}</p>
      ${est ? `<p>Using ${(est.usage / 1048576).toFixed(1)} MB.</p>` : ''}
      ${persisted ? '' : '<button class="btn small" data-act="persist">Ask for protection</button>'}`;
  }
}

// ---------------------------------------------------------------- forms
function field(label, control, hint) {
  return `<label class="field"><span>${label}</span>${control}${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
}
const input = (name, value = '', attrs = '') => `<input name="${name}" value="${esc(value)}" ${attrs}>`;
function select(name, options, value, attrs = '') {
  return `<select name="${name}" ${attrs}>${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
const whenField = (iso) => field('When', `<input type="datetime-local" name="at" value="${nowLocalInput(iso ? new Date(iso) : new Date())}" required>`);
const photoField = () => field('Photos', '<input type="file" name="photos" accept="image/*" multiple>', 'Take a new photo or pick from your gallery.');
// Unchanged "When" field (same minute as now) keeps the exact time, so entries sort correctly.
const atFrom = (fd) => (fd.get('at') === nowLocalInput() ? new Date() : new Date(fd.get('at'))).toISOString();
async function photosFrom(fd) {
  const ids = [];
  for (const f of fd.getAll('photos')) if (f && f.size) ids.push(await savePhoto(f));
  return ids;
}
function containerOptions() { return live(S.containers).map((k) => [k.id, k.name]); }
function activePlantingOptions(includeRecent = false) {
  const t = today();
  return live(S.plantings)
    .filter((p) => (p.status || 'active') === 'active' || (includeRecent && p.endDate && M.daysBetween(p.endDate, t) <= 14))
    .map((p) => [p.id, `${plantingLabel(p)} (${byId(S.containers, p.containerId)?.name || ''})`]);
}

function openSheet({ title, body, submit = 'Save', onSubmit, extra = '', setup }) {
  sheetEl.innerHTML = `<form class="sheet-body" novalidate><h2 id="sheet-title">${title}</h2><p class="form-error" hidden></p>${body}
    <div class="sheet-actions">${extra}<span class="spacer"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${submit}</button></div></form>`;
  const form = sheetEl.querySelector('form');
  form.querySelector('[data-close]').onclick = () => sheetEl.close();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = form.querySelector('.form-error');
    if (!form.checkValidity()) { err.textContent = 'Fill in the required fields.'; err.hidden = false; form.reportValidity(); return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const msg = await onSubmit(new FormData(form), form);
      sheetEl.close();
      await load();
      render();
      if (msg) toast(msg);
    } catch (e) {
      err.textContent = e.message; err.hidden = false; btn.disabled = false;
    }
  };
  if (setup) setup(form);
  sheetEl.showModal();
}

function timingFields(t = {}, cropKey = 'other') {
  const c = crop(cropKey);
  const ph = (v) => (v != null ? `placeholder="typical ${v}"` : '');
  return `<details class="more" ${t.germMin || t.dtmMin ? 'open' : ''}><summary>Numbers from the seed packet (optional)</summary>
    <div class="pair">${field('Sprouts in, from (days)', input('germMin', t.germMin, `type="number" min="0" inputmode="numeric" ${ph(c.germ?.[0])}`))}${field('to (days)', input('germMax', t.germMax, `type="number" min="0" inputmode="numeric" ${ph(c.germ?.[1])}`))}</div>
    <div class="pair">${field('Days to maturity, from', input('dtmMin', t.dtmMin, `type="number" min="0" inputmode="numeric" ${ph(c.dtm?.[0])}`))}${field('to', input('dtmMax', t.dtmMax, `type="number" min="0" inputmode="numeric" ${ph(c.dtm?.[1])}`))}</div>
    ${field('Final spacing (in)', input('spacing', t.spacing, `type="number" min="0" step="0.5" inputmode="decimal" ${ph(c.spacing)}`))}
    <p class="small muted">Leave blank to use typical values. For transplants, maturity counts from the day it went into the container.</p></details>`;
}
function timingFrom(fd) {
  const n = (k) => { const v = fd.get(k); return v === '' || v === null ? null : Number(v); };
  return { germMin: n('germMin'), germMax: n('germMax'), dtmMin: n('dtmMin'), dtmMax: n('dtmMax'), spacing: n('spacing') };
}
const cropOptions = () => Object.entries(CROPS).map(([k, v]) => [k, v.name]);

const forms = {
  formContainer({ id, preset }) {
    const k = id ? byId(S.containers, id) : null;
    const v = k || (preset === 'bucket'
      ? { name: live(S.containers).length ? `Bucket ${live(S.containers).length + 1}` : 'Bucket', soilGal: M.BUCKET_PRESET.soilGal, diameterIn: M.BUCKET_PRESET.diameterIn, sunHours: '', fertilizeDays: 14 }
      : { name: '', soilGal: '', diameterIn: '', sunHours: '', fertilizeDays: 14 });
    openSheet({
      title: k ? `Edit ${esc(k.name)}` : 'Add container',
      body: field('Name', input('name', v.name, 'required autocomplete="off"'))
        + field('Size', select('preset', [['bucket', '5-gallon bucket'], ['custom', 'Custom']], k ? (k.soilGal == M.BUCKET_PRESET.soilGal && k.diameterIn == M.BUCKET_PRESET.diameterIn ? 'bucket' : 'custom') : (preset === 'bucket' ? 'bucket' : 'custom')))
        + `<div class="pair">${field('Potting mix (gal)', input('soilGal', v.soilGal, 'type="number" step="0.1" min="0.2" required inputmode="decimal"'))}${field('Top opening (in)', input('diameterIn', v.diameterIn, 'type="number" step="0.1" min="2" required inputmode="decimal"'), 'Width across')}</div>`
        + field('Direct sun (hours a day)', input('sunHours', v.sunHours, 'type="number" step="0.5" min="0" max="16" inputmode="decimal"'), 'On a typical clear day. Blank assumes 6.')
        + field('Feed every (days)', input('fertilizeDays', v.fertilizeDays, 'type="number" min="0" inputmode="numeric"'), '0 turns feeding reminders off. Liquid feeds are often every 1 to 2 weeks; follow your product\u2019s label.')
        + field('Notes', `<textarea name="notes">${esc(k?.notes || '')}</textarea>`),
      extra: k ? '<button type="button" class="btn danger" data-del>Delete</button>' : '',
      setup(form) {
        form.preset.onchange = () => {
          if (form.preset.value === 'bucket') { form.soilGal.value = M.BUCKET_PRESET.soilGal; form.diameterIn.value = M.BUCKET_PRESET.diameterIn; }
        };
        const del = form.querySelector('[data-del]');
        if (del) del.onclick = async () => {
          if (!confirm(`Delete ${k.name}? Its history stays in the journal and in backups.`)) return;
          await db.softDelete('containers', k.id);
          sheetEl.close(); await load(); location.hash = '#garden';
        };
      },
      async onSubmit(fd) {
        const rec = {
          name: fd.get('name').trim(), soilGal: Number(fd.get('soilGal')), diameterIn: Number(fd.get('diameterIn')),
          sunHours: fd.get('sunHours') === '' ? '' : Number(fd.get('sunHours')),
          fertilizeDays: Number(fd.get('fertilizeDays')) || 0, notes: fd.get('notes'),
        };
        if (k) { await db.update('containers', k.id, rec); return 'Saved'; }
        const n = await db.create('containers', rec);
        location.hash = `#container/${n.id}`;
        return 'Container added';
      },
    });
  },

  formPlanting({ id, container, seed }) {
    if (!live(S.containers).length) { toast('Add a container first'); return; }
    const p = id ? byId(S.plantings, id) : null;
    const s = seed ? byId(S.seeds, seed) : p?.seedId ? byId(S.seeds, p.seedId) : null;
    const cropKey = p?.crop || s?.crop || 'radish';
    const v = p || {
      containerId: container || live(S.containers)[0].id, crop: cropKey, variety: s?.variety || '', seedId: s?.id || '',
      method: crop(cropKey).method, plantedDate: today(), count: '', timing: s?.timing || {},
    };
    const seedOpts = [['', 'None'], ...live(S.seeds).map((x) => [x.id, `${crop(x.crop).name}${x.variety ? ', ' + x.variety : ''}`])];
    openSheet({
      title: p ? 'Edit planting' : 'Add planting',
      body: field('Container', select('containerId', containerOptions(), v.containerId))
        + `<div class="pair">${field('Crop', select('crop', cropOptions(), v.crop))}${field('Variety', input('variety', v.variety, 'autocomplete="off"'))}</div>`
        + field('From seed packet', select('seedId', seedOpts, v.seedId || ''))
        + `<div class="pair">${field('How', select('plantMethod', Object.entries(METHODS), v.method))}${field('Planted on', input('plantedDate', v.plantedDate, 'type="date" required'))}</div>`
        + field('How many', input('count', v.count, 'type="number" min="0" inputmode="numeric"'), 'Seeds, cloves or plants. Used for germination rate.')
        + timingFields(v.timing, v.crop)
        + field('Notes', `<textarea name="notes">${esc(p?.notes || '')}</textarea>`),
      extra: p ? '<button type="button" class="btn danger" data-del>Delete</button>' : '',
      setup(form) {
        form.crop.onchange = () => {
          const c = crop(form.crop.value);
          form.plantMethod.value = c.method;
          const ph = { germMin: c.germ?.[0], germMax: c.germ?.[1], dtmMin: c.dtm?.[0], dtmMax: c.dtm?.[1], spacing: c.spacing };
          for (const [k2, val] of Object.entries(ph)) form[k2].placeholder = val != null ? `typical ${val}` : '';
        };
        form.seedId.onchange = () => {
          const x = byId(S.seeds, form.seedId.value);
          if (!x) return;
          form.crop.value = x.crop; form.crop.onchange();
          if (x.variety) form.variety.value = x.variety;
          for (const k2 of ['germMin', 'germMax', 'dtmMin', 'dtmMax', 'spacing']) if (x.timing?.[k2] != null) form[k2].value = x.timing[k2];
          form.querySelector('details').open = true;
        };
        const del = form.querySelector('[data-del]');
        if (del) del.onclick = async () => {
          if (!confirm('Delete this planting? Use Finished instead if it simply ended. Deleted plantings stay in backups.')) return;
          await db.softDelete('plantings', p.id);
          sheetEl.close(); await load(); location.hash = `#container/${p.containerId}`;
        };
      },
      async onSubmit(fd) {
        const rec = {
          containerId: fd.get('containerId'), crop: fd.get('crop'), variety: fd.get('variety').trim(), seedId: fd.get('seedId') || null,
          method: fd.get('plantMethod'), plantedDate: fd.get('plantedDate'), count: fd.get('count') === '' ? '' : Number(fd.get('count')),
          timing: timingFrom(fd), notes: fd.get('notes'),
        };
        if (p) { await db.update('plantings', p.id, rec); return 'Saved'; }
        const n = await db.create('plantings', { ...rec, status: 'active' });
        location.hash = `#planting/${n.id}`;
        return 'Planting added';
      },
    });
  },

  formSeed({ id }) {
    const s = id ? byId(S.seeds, id) : null;
    const v = s || { crop: 'radish', variety: '', source: '', packedFor: new Date().getFullYear(), quantity: '', timing: {} };
    openSheet({
      title: s ? 'Edit seed packet' : 'Add seed packet',
      body: `<div class="pair">${field('Crop', select('crop', cropOptions(), v.crop))}${field('Variety', input('variety', v.variety, 'autocomplete="off"'))}</div>`
        + `<div class="pair">${field('Brand or source', input('source', v.source))}${field('Packed for (year)', input('packedFor', v.packedFor, 'type="number" min="1990" max="2100" inputmode="numeric"'))}</div>`
        + field('Amount left', input('quantity', v.quantity, 'placeholder="e.g. about half a packet"'))
        + timingFields(v.timing, v.crop).replace('<details class="more"', '<details class="more" open')
        + field('Packet photo', '<input type="file" name="photos" accept="image/*">', s?.photoId ? 'Choosing a new photo replaces the current one.' : 'The back of the packet is the useful side.')
        + field('Notes', `<textarea name="notes">${esc(s?.notes || '')}</textarea>`),
      extra: s ? '<button type="button" class="btn danger" data-del>Delete</button>' : '',
      setup(form) {
        const del = form.querySelector('[data-del]');
        if (del) del.onclick = async () => {
          if (!confirm('Delete this packet?')) return;
          await db.softDelete('seeds', s.id); sheetEl.close(); await load(); location.hash = '#seeds';
        };
      },
      async onSubmit(fd) {
        const photos = await photosFrom(fd);
        const rec = {
          crop: fd.get('crop'), variety: fd.get('variety').trim(), source: fd.get('source').trim(),
          packedFor: fd.get('packedFor') ? Number(fd.get('packedFor')) : '', quantity: fd.get('quantity').trim(),
          timing: timingFrom(fd), notes: fd.get('notes'),
        };
        if (photos[0]) rec.photoId = photos[0];
        if (s) { await db.update('seeds', s.id, rec); return 'Saved'; }
        const n = await db.create('seeds', rec);
        location.hash = `#seed/${n.id}`;
        return 'Packet added';
      },
    });
  },

  formWater({ id }) {
    const withPlants = live(S.containers);
    const c = ctx();
    const checked = id ? [id] : withPlants.filter((k) => M.containerStatus(k, c).status === 'due').map((k) => k.id);
    openSheet({
      title: 'Log watering',
      body: `<div class="field"><span>Containers</span><div class="choices">${withPlants.map((k) => `<label><input type="checkbox" name="containers" value="${k.id}" ${checked.includes(k.id) ? 'checked' : ''}><span>${esc(k.name)}</span></label>`).join('')}</div></div>`
        + field('Amount (gal)', input('amountGal', '', 'type="number" step="0.1" min="0" inputmode="decimal" placeholder="Until it drains"'), 'Leave blank if you watered until water ran out the bottom.')
        + whenField(),
      submit: 'Log watering',
      async onSubmit(fd) {
        const ids = fd.getAll('containers');
        if (!ids.length) throw new Error('Pick at least one container.');
        const amt = fd.get('amountGal') ? Number(fd.get('amountGal')) : null;
        for (const cid of ids) await addEvent('water', { containerId: cid, at: atFrom(fd), data: amt ? { amountGal: amt } : {} });
        return ids.length > 1 ? `Watered ${ids.length} containers` : 'Watered';
      },
    });
  },

  formFeed({ id }) {
    const lastProduct = live(S.events).filter((e) => e.type === 'fertilize' && e.data?.product).sort((a, b) => b.at.localeCompare(a.at))[0]?.data.product || '';
    openSheet({
      title: 'Log feeding',
      body: field('Container', select('containerId', containerOptions(), id || containerOptions()[0]?.[0]))
        + field('Product', input('product', lastProduct, 'placeholder="e.g. fish emulsion, 1 tbsp per gallon"'))
        + whenField() + field('Note', '<textarea name="text"></textarea>'),
      submit: 'Log feeding',
      async onSubmit(fd) {
        await addEvent('fertilize', { containerId: fd.get('containerId'), at: atFrom(fd), data: { product: fd.get('product').trim(), text: fd.get('text') } });
        return 'Feeding logged';
      },
    });
  },

  formSoil({ id }) {
    openSheet({
      title: 'Soil or compost',
      body: field('Container', select('containerId', containerOptions(), id))
        + field('What', select('kind', [['Compost top-dress', 'Compost top-dress'], ['Mixed in compost', 'Mixed in compost'], ['Refreshed potting mix', 'Refreshed potting mix'], ['Added amendment', 'Other amendment']], 'Compost top-dress'))
        + field('Details', '<textarea name="details" placeholder="e.g. about 1 inch of finished compost"></textarea>')
        + whenField(),
      async onSubmit(fd) {
        await addEvent('soil', { containerId: fd.get('containerId'), at: atFrom(fd), data: { kind: fd.get('kind'), details: fd.get('details') } });
        return 'Logged';
      },
    });
  },

  formMoisture({ id }) {
    openSheet({
      title: 'Soil check',
      body: '<p class="muted small">Push a finger about an inch into the mix, or lift the bucket.</p>'
        + `<div class="field choices">
          <label><input type="radio" name="level" value="dry" required><span><b>Dry</b><br><span class="small muted">Dry an inch down, bucket feels light</span></span></label>
          <label><input type="radio" name="level" value="moist"><span><b>Moist</b><br><span class="small muted">Cool and damp, not soggy</span></span></label>
          <label><input type="radio" name="level" value="wet"><span><b>Wet</b><br><span class="small muted">Soggy, or just drained</span></span></label></div>`
        + whenField(),
      submit: 'Save check',
      async onSubmit(fd) {
        await addEvent('moisture', { containerId: id, at: atFrom(fd), data: { level: fd.get('level') } });
        return 'Estimate updated';
      },
    });
  },

  formHarvest({ id }) {
    const opts = activePlantingOptions(true);
    if (!opts.length) { toast('Add a planting first'); return; }
    const pid = id || opts[0][0];
    const unitOf = (x) => crop(byId(S.plantings, x)?.crop).unit;
    openSheet({
      title: 'Log harvest',
      body: field('Planting', select('plantingId', opts, pid))
        + `<div class="pair">${field('Amount', input('amount', '', 'type="number" step="any" min="0" inputmode="decimal"'))}${field('Unit', select('unit', UNITS.map((u) => [u, u]), unitOf(pid)))}</div>`
        + whenField() + photoField() + field('Note', '<textarea name="text" placeholder="Size, taste, anything worth remembering"></textarea>'),
      submit: 'Log harvest',
      setup(form) { form.plantingId.onchange = () => { form.unit.value = unitOf(form.plantingId.value); }; },
      async onSubmit(fd) {
        const p = byId(S.plantings, fd.get('plantingId'));
        await addEvent('harvest', {
          plantingId: p.id, containerId: p.containerId, at: atFrom(fd), photoIds: await photosFrom(fd),
          data: { amount: fd.get('amount') === '' ? null : Number(fd.get('amount')), unit: fd.get('unit'), text: fd.get('text') },
        });
        return 'Harvest logged';
      },
    });
  },

  formNote({ planting, container }) {
    const targets = [['', 'Whole garden'], ...live(S.containers).map((k) => [`c:${k.id}`, k.name]), ...activePlantingOptions().map(([v, l]) => [`p:${v}`, l])];
    const sel = planting ? `p:${planting}` : container ? `c:${container}` : '';
    openSheet({
      title: 'Add note',
      body: field('About', select('about', targets, sel))
        + `<div class="field choices" style="grid-template-columns:1fr 1fr"><label><input type="radio" name="kind" value="note" checked><span>Note</span></label><label><input type="radio" name="kind" value="problem"><span>Problem</span></label></div>`
        + field('What you saw', '<textarea name="text" required></textarea>')
        + `<div data-problem hidden>${field('What you did about it', '<textarea name="action"></textarea>')}</div>`
        + photoField() + whenField(),
      setup(form) {
        const box = form.querySelector('[data-problem]');
        form.querySelectorAll('[name=kind]').forEach((r) => { r.onchange = () => { box.hidden = form.kind.value !== 'problem'; }; });
      },
      async onSubmit(fd) {
        const t = fd.get('about');
        let containerId = null, plantingId = null;
        if (t.startsWith('c:')) containerId = t.slice(2);
        if (t.startsWith('p:')) { plantingId = t.slice(2); containerId = byId(S.plantings, plantingId)?.containerId || null; }
        const kind = fd.get('kind');
        await addEvent(kind, {
          containerId, plantingId, at: atFrom(fd), photoIds: await photosFrom(fd),
          data: kind === 'problem' ? { text: fd.get('text'), action: fd.get('action'), resolved: false } : { text: fd.get('text') },
        });
        return kind === 'problem' ? 'Problem logged' : 'Note added';
      },
    });
  },

  formSprouted({ id }) {
    const p = byId(S.plantings, id);
    openSheet({
      title: `${esc(plantingLabel(p))} sprouted`,
      body: field('How many came up', input('count', '', 'type="number" min="0" inputmode="numeric"'), p.count ? `Out of ${esc(p.count)} sown. Optional.` : 'Optional.') + whenField() + photoField(),
      submit: 'Log sprouting',
      async onSubmit(fd) {
        await addEvent('sprouted', { plantingId: p.id, containerId: p.containerId, at: atFrom(fd), photoIds: await photosFrom(fd), data: { count: fd.get('count') === '' ? null : Number(fd.get('count')) } });
        return 'Sprouting logged. Thinning reminder set.';
      },
    });
  },

  formThinned({ id }) {
    const p = byId(S.plantings, id);
    openSheet({
      title: `Thin ${esc(plantingLabel(p))}`,
      body: field('How many you kept', input('kept', '', 'type="number" min="0" inputmode="numeric"')) + whenField() + field('Note', '<textarea name="text"></textarea>'),
      submit: 'Log thinning',
      async onSubmit(fd) {
        await addEvent('thinned', { plantingId: p.id, containerId: p.containerId, at: atFrom(fd), data: { kept: fd.get('kept') === '' ? null : Number(fd.get('kept')), text: fd.get('text') } });
        return 'Thinning logged';
      },
    });
  },

  formFinish({ id }) {
    const p = byId(S.plantings, id);
    openSheet({
      title: `Finish ${esc(plantingLabel(p))}`,
      body: '<p class="muted small">Moves it to the container\u2019s history. Its records stay.</p>'
        + field('Outcome', select('outcome', [['harvested', 'All harvested'], ['removed', 'Pulled or removed'], ['died', 'Died']], 'harvested'))
        + field('Date', input('endDate', today(), 'type="date" required')) + field('Note', '<textarea name="text"></textarea>'),
      submit: 'Mark finished',
      async onSubmit(fd) {
        const endDate = fd.get('endDate');
        await db.update('plantings', p.id, { status: fd.get('outcome'), endDate });
        await addEvent('finished', { plantingId: p.id, containerId: p.containerId, at: new Date(endDate + 'T' + nowLocalInput().slice(11)).toISOString(), data: { outcome: fd.get('outcome'), text: fd.get('text') } });
        return 'Marked finished';
      },
    });
  },

  formLocation() {
    const st = S.settings;
    openSheet({
      title: 'Location',
      body: '<p class="muted small">Decimal degrees. West longitudes are negative.</p>'
        + `<div class="pair">${field('Latitude', input('lat', st.lat ?? '', 'type="number" step="any" min="-90" max="90" required inputmode="decimal"'))}${field('Longitude', input('lon', st.lon ?? '', 'type="number" step="any" min="-180" max="180" required inputmode="decimal"'))}</div>`,
      async onSubmit(fd) {
        await saveLocation(Number(fd.get('lat')), Number(fd.get('lon')));
        return 'Location saved';
      },
    });
  },
};

async function saveLocation(lat, lon) {
  S.settings = { ...S.settings, lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
  await db.setMeta('settings', S.settings);
  refreshWeather(true);
}

function openEvent(id) {
  const e = byId(S.events, id);
  if (!e) return;
  const d = e.data || {};
  const photos = (e.photoIds || []).map((pid) => `<img class="photo-full" data-photo="${pid}" data-size="blob" alt="Photo">`).join('');
  const editable = ['note', 'problem', 'harvest'].includes(e.type);
  openSheet({
    title: esc(eventSummary(e)),
    body: `<p class="muted">${fmtDate(M.eventDay(e))}, ${fmtTime(e.at)}</p>`
      + (editable
        ? (e.type === 'harvest'
          ? `<div class="pair">${field('Amount', input('amount', d.amount ?? '', 'type="number" step="any" min="0" inputmode="decimal"'))}${field('Unit', select('unit', UNITS.map((u) => [u, u]), d.unit))}</div>`
          : '')
          + field(e.type === 'harvest' ? 'Note' : 'What you saw', `<textarea name="text">${esc(d.text || '')}</textarea>`)
          + (e.type === 'problem' ? field('What you did about it', `<textarea name="action">${esc(d.action || '')}</textarea>`) + `<label class="field" style="display:flex;gap:10px;align-items:center"><input type="checkbox" name="resolved" ${d.resolved ? 'checked' : ''} style="width:20px;height:20px"><span style="margin:0">Resolved</span></label>` : '')
        : [d.text, d.details, d.action].filter(Boolean).map((t) => `<p>${esc(t)}</p>`).join(''))
      + photos,
    submit: editable ? 'Save' : 'Done',
    extra: '<button type="button" class="btn danger" data-del>Delete</button>',
    setup(form) {
      hydratePhotos(form);
      form.querySelector('[data-del]').onclick = async () => {
        if (!confirm('Delete this entry? It stays in backups made before today.')) return;
        await db.softDelete('events', e.id);
        sheetEl.close(); await load(); render(); toast('Entry deleted');
      };
    },
    async onSubmit(fd) {
      if (!editable) return null;
      const patch = { ...d, text: fd.get('text') };
      if (e.type === 'harvest') { patch.amount = fd.get('amount') === '' ? null : Number(fd.get('amount')); patch.unit = fd.get('unit'); }
      if (e.type === 'problem') { patch.action = fd.get('action'); patch.resolved = fd.get('resolved') === 'on'; }
      await db.update('events', e.id, { data: patch });
      return 'Saved';
    },
  });
}

// ---------------------------------------------------------------- actions
async function doBackup(share) {
  const prevBackup = S.lastBackupAt;
  await db.setMeta('lastBackupAt', new Date().toISOString()); // included in the file itself
  const data = await db.exportBackup(APP_VERSION);
  const name = `garden-backup-${today()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Garden Log backup' }); } catch (e) {
      await db.setMeta('lastBackupAt', prevBackup);
      if (e.name === 'AbortError') return;
      throw e;
    }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  S.lastBackupAt = await db.getMeta('lastBackupAt');
  render();
  toast('Backup file created');
}

const actions = {
  ...forms,
  async quickWater({ id }) {
    const c = ctx();
    let target = id;
    if (!target) {
      const planted = c.containers.filter((k) => M.activePlantingsOn(k.id, c.today, c.plantings).length);
      const pool = planted.length ? planted : c.containers;
      if (pool.length !== 1) return forms.formWater({});
      target = pool[0].id;
    }
    const e = await addEvent('water', { containerId: target });
    await load(); render();
    toast(`Watered ${byId(S.containers, target).name}`, async () => { await db.hardDelete('events', e.id); await load(); render(); });
  },
  openEvent: ({ id }) => openEvent(id),
  filter({ f }) { S.journalFilter = f; render(); },
  async useLocation() {
    try { const p = await getPosition(); await saveLocation(p.lat, p.lon); toast('Location saved'); render(); } catch (e) { toast(e.message); }
  },
  refreshWeather: () => refreshWeather(true).then(() => toast(S.weatherError ? 'Weather update failed' : 'Weather updated')),
  exportBackup: () => doBackup(false).catch((e) => toast(e.message)),
  shareBackup: () => doBackup(true).catch((e) => toast(e.message)),
  async restoreSnap({ id }) {
    if (!confirm('Replace current data with this safety copy? Your current data is saved as a new safety copy first. Photos are not affected.')) return;
    await db.restoreSnapshot(id); await load(); render(); toast('Restored');
  },
  async persist() {
    const ok = navigator.storage?.persist ? await navigator.storage.persist() : false;
    toast(ok ? 'Storage protected' : 'The browser declined. Install the app to your home screen and try again.');
    render();
  },
  applyUpdate() {
    navigator.serviceWorker.getRegistration().then((r) => r?.waiting?.postMessage('skipWaiting'));
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || el.type === 'file') return;
  const fn = actions[el.dataset.act];
  if (fn) { ev.preventDefault(); fn({ ...el.dataset }); }
});
document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.act === 'year') location.hash = `#season/${el.value}`;
  if (el.dataset.act === 'importBackup' && el.files[0]) {
    try {
      const obj = JSON.parse(await el.files[0].text());
      const problem = db.checkBackup(obj);
      if (problem) throw new Error(problem);
      if (!confirm(`Replace all current data with the backup from ${new Date(obj.exportedAt).toLocaleString()}? Current data is saved as a safety copy first.`)) return;
      await db.importBackup(obj);
      await load(); render(); toast('Backup restored');
    } catch (e) {
      toast(e instanceof SyntaxError ? 'That file isn\u2019t a readable backup.' : e.message);
    } finally { el.value = ''; }
  }
});
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { refreshWeather(); render(); }
});

// ---------------------------------------------------------------- service worker
function setupSW() {
  if (!('serviceWorker' in navigator)) return;
  const banner = document.getElementById('update');
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const show = () => { banner.hidden = false; };
    if (reg.waiting && navigator.serviceWorker.controller) show();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) show(); });
    });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
}

// ---------------------------------------------------------------- start
(async function start() {
  try {
    S.migration = await db.runMigrations();
  } catch (e) {
    view.innerHTML = `<h1>Data upgrade stopped</h1><p>Nothing was changed. ${esc(e.message)}</p><p>Your data is untouched. Reload to try again; if it keeps failing, restore the previous app version and save a backup file from Settings.</p>`;
    setupSW();
    return;
  }
  await load();
  render();
  setupSW();
  if (navigator.storage?.persist) navigator.storage.persisted().then((p) => { if (!p) navigator.storage.persist(); });
  refreshWeather();
})();
