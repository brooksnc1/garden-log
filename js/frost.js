// Frost outlook, shared by the app (Today screen) and the service worker
// (background notifications). Plain script on purpose: the app imports it,
// the service worker loads it with importScripts. Needs crops-data.js first.
//
// Levels, by the forecast overnight low (air temperature at 2 m):
//   light frost  29–35°F  Frost forms on leaves on clear, calm nights even
//                         with air above 32°F. Tender crops are damaged;
//                         cool-season crops shrug it off.
//   hard frost   28°F and below  A hard freeze. Damages most crops that
//                         aren't fully hardy, including chard and radish.
// Containers get colder than the ground, so each crop's own limit gets a 3°F
// margin. A crop can be at risk with no frost at all (basil below ~43°F).

(function (g) {
  const LIGHT_MAX = 35;
  const HARD_MAX = 28;
  const POT_MARGIN = 3;
  const LOOKAHEAD_DAYS = 2;

  function level(tminF) {
    if (tminF == null) return null;
    if (tminF <= HARD_MAX) return 'hard';
    if (tminF <= LIGHT_MAX) return 'light';
    return null;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function addDays(date, n) {
    const d = new Date(date + 'T12:00');
    d.setDate(d.getDate() + n);
    return ymd(d);
  }
  const weekday = (date) => new Date(date + 'T12:00').toLocaleDateString(undefined, { weekday: 'long' });

  // The low for a date happens around sunrise, so it belongs to the night before.
  function whenText(date, now) {
    const today = ymd(now);
    if (date === today) return 'this morning';
    if (date === addDays(today, 1)) return 'tonight';
    return `${weekday(addDays(date, -1))} night`;
  }

  // weatherByDate: Map or plain object of date -> { tminF }
  // Returns one entry per night with frost or an at-risk crop, soonest first.
  function outlook({ weatherByDate, containers, plantings, now = new Date() }) {
    const crops = g.GARDEN_CROPS;
    const cropOf = (k) => crops[k] || crops.other;
    const get = (d) => (weatherByDate instanceof Map ? weatherByDate.get(d) : weatherByDate[d]);
    const today = ymd(now);
    const out = [];
    for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
      const date = addDays(today, i);
      // This morning's low has already happened by mid-morning.
      if (i === 0 && now.getHours() >= 9) continue;
      const w = get(date);
      if (!w || w.tminF == null) continue;
      const tmin = w.tminF;
      const lvl = level(tmin);
      const affected = [];
      for (const c of containers) {
        if (c.deletedAt) continue;
        const act = plantings.filter((p) => !p.deletedAt && p.containerId === c.id
          && (p.status || 'active') === 'active' && p.plantedDate <= date);
        if (!act.length) continue;
        const names = (list) => [...new Set(list.map((p) => cropOf(p.crop).name))];
        const risk = act.filter((p) => tmin <= cropOf(p.crop).minTempF + POT_MARGIN);
        const fine = act.filter((p) => !risk.includes(p));
        affected.push({ containerId: c.id, container: c.name, atRisk: names(risk), fine: names(fine) });
      }
      if (!affected.length) continue;
      const anyRisk = affected.some((a) => a.atRisk.length);
      if (!lvl && !anyRisk) continue;
      out.push({ date, tmin: Math.round(tmin), level: lvl || 'chill', anyRisk, affected, when: whenText(date, now) });
    }
    return out;
  }

  const lower = (n) => (/^Swiss/.test(n) ? n : n[0].toLowerCase() + n.slice(1));
  const cap = (t) => t[0].toUpperCase() + t.slice(1);
  const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const LABEL = { hard: 'Hard frost', light: 'Light frost', chill: 'Cold' };

  function describe(ev) {
    const title = `${LABEL[ev.level]} ${ev.when}: low ${ev.tmin}°F`;
    const parts = [];
    for (const a of ev.affected) {
      if (a.atRisk.length) parts.push(`${cap(list(a.atRisk.map(lower)))} in ${a.container} could be damaged.`);
    }
    if (ev.anyRisk) {
      parts.push('Move the bucket against the house or into a garage, or cover it overnight with a sheet or a box (not plastic touching the leaves).');
      const fine = [...new Set(ev.affected.flatMap((a) => a.fine))];
      if (fine.length) parts.push(`${cap(list(fine.map(lower)))} should be fine.`);
    } else {
      const all = [...new Set(ev.affected.flatMap((a) => a.fine))];
      parts.push(`Nothing at risk: ${list(all.map(lower))} ${all.length > 1 ? 'all handle' : 'handles'} this.`);
    }
    return { title, body: parts.join(' ') };
  }

  // setting: 'off' | 'hard' | 'all'
  function wanted(ev, setting) {
    if (setting === 'all') return true;
    if (setting === 'hard') return ev.level === 'hard';
    return false;
  }

  const key = (ev) => `${ev.date}|${ev.level}`;

  g.GardenFrost = { level, outlook, describe, wanted, key, LIGHT_MAX, HARD_MAX, LABEL };
})(globalThis);
