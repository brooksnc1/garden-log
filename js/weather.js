import { putMany, getMeta, setMeta } from './db.js';

// Open-Meteo: free, no API key. past_days backfills up to 92 days, so a week
// away from the app leaves no holes in the water model.
const REFRESH_MS = 3 * 60 * 60 * 1000;

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function weatherIsStale() {
  const last = await getMeta('weatherFetchedAt');
  return !last || Date.now() - new Date(last).getTime() > REFRESH_MS;
}

export async function fetchWeather(lat, lon, lastKnownDate) {
  // Ask for as many past days as needed to cover the gap (max 92).
  let pastDays = 14;
  if (lastKnownDate) {
    const gap = Math.ceil((Date.now() - new Date(lastKnownDate + 'T12:00').getTime()) / 864e5) + 2;
    pastDays = Math.min(92, Math.max(pastDays, gap));
  } else {
    pastDays = 92;
  }
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
    + '&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max,temperature_2m_min,sunrise,sunset,daylight_duration,sunshine_duration'
    + '&temperature_unit=fahrenheit&timezone=auto'
    + `&past_days=${pastDays}&forecast_days=7`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
  const j = await res.json();
  const d = j.daily;
  if (!d || !d.time) throw new Error('Weather service returned no daily data');
  const today = localDate();
  const now = new Date().toISOString();
  const recs = d.time.map((date, i) => ({
    date,
    rainMm: d.precipitation_sum[i],
    et0Mm: d.et0_fao_evapotranspiration[i],
    tmaxF: d.temperature_2m_max[i],
    tminF: d.temperature_2m_min[i],
    sunrise: d.sunrise?.[i] ?? null,               // local time, e.g. "2026-09-23T07:28"
    sunset: d.sunset?.[i] ?? null,
    daylightH: d.daylight_duration?.[i] != null ? d.daylight_duration[i] / 3600 : undefined,
    sunshineH: d.sunshine_duration?.[i] != null ? d.sunshine_duration[i] / 3600 : undefined,
    kind: date < today ? 'past' : date === today ? 'today' : 'forecast',
    fetchedAt: now,
  })).filter((r) => r.et0Mm !== null && r.et0Mm !== undefined);
  await putMany('weather', recs);
  await setMeta('weatherFetchedAt', now);
  return recs.length;
}

export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser can\u2019t share location. Enter coordinates instead.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission was denied. Enter coordinates instead.' : 'Couldn\u2019t get your location. Enter coordinates instead.')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 3600e3 },
    );
  });
}
