// Storage layer.
//
// Data safety rules (keep these when adding features):
//  1. Records are only ever merged, never rebuilt: update() spreads the stored
//     record first, so fields this version doesn't know about survive.
//  2. Events (waterings, harvests, notes...) are the history. They are never
//     rewritten by the app; user deletes are soft (deletedAt).
//  3. Photos are immutable blobs. Migrations never touch the photos store.
//  4. Schema changes happen only through MIGRATIONS below. Each migration is a
//     pure function over a plain-JSON dump, so the same code upgrades both the
//     live database and old backup files. The live upgrade saves a snapshot
//     first and writes everything back in one transaction: if anything throws,
//     nothing is written.

export const SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// MIGRATIONS
// Append new entries; never edit or remove a shipped one.
// `up(data)` receives { meta, containers, plantings, events, seeds, weather }
// (arrays of records; meta is a plain object) and returns the same shape.
//
// Example for a future v2:
// {
//   to: 2,
//   describe: 'Harvest events get a quality rating',
//   up(data) {
//     data.events = data.events.map(e =>
//       e.type === 'harvest' ? { ...e, data: { quality: null, ...e.data } } : e);
//     return data;
//   },
// },
// ---------------------------------------------------------------------------
export const MIGRATIONS = [
  {
    to: 2,
    describe: 'Containers: sun hours are now calculated from sunrise/sunset; the user enters hours of shade instead',
    up(data) {
      // The old sunHours value is left in place (unused) so nothing is lost.
      data.containers = data.containers.map((c) => (c.shadeHours === undefined ? { ...c, shadeHours: 0 } : c));
      return data;
    },
  },
];

// Structural IndexedDB versions (new object stores / indexes). Separate from
// SCHEMA_VERSION: this only changes when a new store is needed.
const DB_NAME = 'garden-tracker';
const IDB_VERSION = 1;
const IDB_UPGRADES = {
  1(db) {
    db.createObjectStore('meta', { keyPath: 'key' });
    for (const s of ['containers', 'plantings', 'events', 'seeds', 'photos', 'snapshots']) {
      db.createObjectStore(s, { keyPath: 'id' });
    }
    db.createObjectStore('weather', { keyPath: 'date' });
  },
};

export const DATA_STORES = ['containers', 'plantings', 'events', 'seeds', 'weather'];
const MAX_SNAPSHOTS = 5;

let dbp = null;
export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      for (let v = e.oldVersion + 1; v <= IDB_VERSION; v++) IDB_UPGRADES[v](db, req.transaction);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close other tabs of this app and reload.'));
  });
  return dbp;
}

function done(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
  });
}
function reqP(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export async function getAll(store) {
  const db = await openDB();
  return reqP(db.transaction(store).objectStore(store).getAll());
}
export async function get(store, key) {
  const db = await openDB();
  return reqP(db.transaction(store).objectStore(store).get(key));
}
export async function put(store, rec) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(rec);
  await done(tx);
  return rec;
}
export async function putMany(store, recs) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const r of recs) os.put(r);
  await done(tx);
}
export async function hardDelete(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

export async function create(store, fields) {
  const now = new Date().toISOString();
  return put(store, { id: uid(), createdAt: now, updatedAt: now, ...fields });
}

// Merge a patch into a stored record. Unknown fields are kept.
export async function update(store, id, patch) {
  const cur = await get(store, id);
  if (!cur) throw new Error(`Record not found: ${store}/${id}`);
  return put(store, { ...cur, ...patch, id, updatedAt: new Date().toISOString() });
}

export async function softDelete(store, id) {
  return update(store, id, { deletedAt: new Date().toISOString() });
}

export async function getMeta(key, fallback = null) {
  const r = await get('meta', key);
  return r ? r.value : fallback;
}
export async function setMeta(key, value) {
  return put('meta', { key, value });
}

// ---------------------------------------------------------------------------
// Dumps, snapshots, migrations
// ---------------------------------------------------------------------------
async function dump() {
  const data = { meta: {} };
  for (const m of await getAll('meta')) data.meta[m.key] = m.value;
  for (const s of DATA_STORES) data[s] = await getAll(s);
  return data;
}

// Write a full dump back (photos untouched) in ONE transaction.
async function writeDump(data) {
  const db = await openDB();
  const stores = ['meta', ...DATA_STORES];
  const tx = db.transaction(stores, 'readwrite');
  const p = done(tx);
  try {
    for (const s of stores) tx.objectStore(s).clear();
    for (const [key, value] of Object.entries(data.meta || {})) tx.objectStore('meta').put({ key, value });
    for (const s of DATA_STORES) for (const r of data[s] || []) tx.objectStore(s).put(r);
  } catch (e) {
    tx.abort();
    throw e;
  }
  return p;
}

export async function takeSnapshot(reason) {
  const data = await dump();
  const snap = { id: uid(), createdAt: new Date().toISOString(), reason, schemaVersion: data.meta.schemaVersion ?? SCHEMA_VERSION, data };
  await put('snapshots', snap);
  const all = (await getAll('snapshots')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const old of all.slice(MAX_SNAPSHOTS)) await hardDelete('snapshots', old.id);
  return snap;
}

export async function listSnapshots() {
  const all = await getAll('snapshots');
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, createdAt, reason, schemaVersion }) => ({ id, createdAt, reason, schemaVersion }));
}

export async function restoreSnapshot(id) {
  const snap = await get('snapshots', id);
  if (!snap) throw new Error('Snapshot not found');
  await takeSnapshot('Before restoring an earlier snapshot');
  const data = migrateData(structuredClone(snap.data), snap.schemaVersion);
  await writeDump(data);
}

// Pure: upgrade a dump from `fromVersion` to SCHEMA_VERSION.
export function migrateData(data, fromVersion) {
  let v = fromVersion;
  for (const m of [...MIGRATIONS].sort((a, b) => a.to - b.to)) {
    if (m.to <= v) continue;
    data = m.up(data);
    v = m.to;
  }
  data.meta = { ...(data.meta || {}), schemaVersion: SCHEMA_VERSION };
  return data;
}

// Called once at startup.
export async function runMigrations() {
  const current = await getMeta('schemaVersion');
  if (current === null) {
    // Brand-new database.
    await setMeta('schemaVersion', SCHEMA_VERSION);
    await setMeta('installedAt', new Date().toISOString());
    return { ran: 0 };
  }
  if (current > SCHEMA_VERSION) {
    return { ran: 0, newerData: true, dataVersion: current };
  }
  if (current === SCHEMA_VERSION) return { ran: 0 };

  await takeSnapshot(`Before upgrading data from v${current} to v${SCHEMA_VERSION}`);
  const data = migrateData(await dump(), current);
  await writeDump(data); // atomic; throws without writing on failure
  return { ran: SCHEMA_VERSION - current };
}

// ---------------------------------------------------------------------------
// Backup files
// ---------------------------------------------------------------------------
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}

export async function exportBackup(appVersion) {
  const data = await dump();
  const photos = [];
  for (const p of await getAll('photos')) {
    const { blob, thumb, ...rest } = p;
    photos.push({ ...rest, blob: blob ? await blobToDataURL(blob) : null, thumb: thumb ? await blobToDataURL(thumb) : null });
  }
  return {
    format: 'garden-tracker-backup',
    schemaVersion: data.meta.schemaVersion ?? SCHEMA_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    ...data,
    photos,
  };
}

export function checkBackup(obj) {
  if (!obj || obj.format !== 'garden-tracker-backup') return 'This file is not a Garden Log backup.';
  if (typeof obj.schemaVersion !== 'number') return 'This backup has no data version and can\u2019t be read safely.';
  if (obj.schemaVersion > SCHEMA_VERSION) return `This backup is from a newer version of the app (data v${obj.schemaVersion}). Update the app, then restore it.`;
  return null;
}

// Replace all data with a backup. Current data is snapshotted first.
export async function importBackup(obj) {
  const err = checkBackup(obj);
  if (err) throw new Error(err);
  const data = { meta: obj.meta || {} };
  for (const s of DATA_STORES) data[s] = obj[s] || [];
  const migrated = migrateData(data, obj.schemaVersion);

  const photos = [];
  for (const p of obj.photos || []) {
    photos.push({ ...p, blob: p.blob ? await dataURLToBlob(p.blob) : null, thumb: p.thumb ? await dataURLToBlob(p.thumb) : null });
  }

  await takeSnapshot('Before restoring a backup file');
  await writeDump(migrated);
  // Photos: add/replace by id; photos not in the backup are kept (they are
  // only reachable if something references them, and cost nothing to keep).
  await putMany('photos', photos);
}
