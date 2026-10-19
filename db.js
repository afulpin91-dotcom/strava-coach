// Stockage local (IndexedDB) : tout reste sur l'appareil.
const NAME = 'strava-coach', VERSION = 1;
let dbp;

function open() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('activities', { keyPath: 'id' });
      d.createObjectStore('streams', { keyPath: 'id' });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(t.error);
  });
}
const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const getAll = store => tx(store, 'readonly', s => wrap(s.getAll()));
export const get = (store, key) => tx(store, 'readonly', s => wrap(s.get(key)));
export const put = (store, value, key) => tx(store, 'readwrite', s => wrap(key === undefined ? s.put(value) : s.put(value, key)));
export const putMany = (store, values) => tx(store, 'readwrite', s => { values.forEach(v => s.put(v)); });
export const del = (store, key) => tx(store, 'readwrite', s => wrap(s.delete(key)));
export const clear = store => tx(store, 'readwrite', s => wrap(s.clear()));
export const getMeta = key => get('meta', key);
export const setMeta = (key, value) => put('meta', value, key);
export const delMeta = key => tx('meta', 'readwrite', s => wrap(s.delete(key)));

/** Charge tout ce dont le moteur a besoin. */
export async function loadContext() {
  const [acts, streamRows, settings, hr_zones, goal, plan, manual, pause, moves, coach, coach_memory, coach_state] = await Promise.all([
    getAll('activities'), getAll('streams'), getMeta('settings'), getMeta('hr_zones'),
    getMeta('goal'), getMeta('plan'), getMeta('manual_races'), getMeta('pause'), getMeta('moves'), getMeta('coach'), getMeta('coach_memory'), getMeta('coach_state'),
  ]);
  acts.sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  const streams = Object.fromEntries(streamRows.filter(r => r.heartrate).map(r => [r.id, r]));
  const s = settings || {};
  return {
    acts, streams, settings: s,
    meta: { hr_zones, goal, plan, manual_races: manual || [], pause: pause || null, moves: moves || [], coach: coach || null, coach_memory: coach_memory || [], coach_state: coach_state || '' },
    cfg: { fcMax: Number(s.fcMax) || 190, fcRepos: Number(s.fcRepos) || 55, fcZones: parseZones(s.fcZones) },
  };
}
export function parseZones(txt) {
  const z = String(txt || '').split(',').map(x => parseInt(x, 10)).filter(Number.isFinite);
  return z.length === 4 ? z : [];
}

/** Sauvegarde complète (jetons exclus). */
export async function exportAll() {
  const settings = { ...((await getMeta('settings')) || {}) };
  delete settings.clientSecret; delete settings.inboxToken;
  return {
    version: 1, exported: new Date().toISOString(), settings,
    activities: await getAll('activities'), streams: await getAll('streams'),
    goal: await getMeta('goal'), plan: await getMeta('plan'), manual_races: await getMeta('manual_races'),
    hr_zones: await getMeta('hr_zones'), pause: await getMeta('pause'), moves: await getMeta('moves'), coach: await getMeta('coach'), coach_memory: await getMeta('coach_memory'), coach_state: await getMeta('coach_state'),
  };
}
export async function importAll(d) {
  if (!d || d.version !== 1) throw new Error('Fichier de sauvegarde invalide.');
  const keep = (await getMeta('settings')) || {};
  await putMany('activities', d.activities || []);
  await putMany('streams', d.streams || []);
  for (const k of ['goal', 'plan', 'manual_races', 'hr_zones', 'pause', 'moves', 'coach', 'coach_memory', 'coach_state']) if (d[k] != null) await setMeta(k, d[k]);
  await setMeta('settings', { ...(d.settings || {}), clientSecret: keep.clientSecret, inboxToken: keep.inboxToken });
}
export async function wipe() {
  for (const s of ['activities', 'streams', 'meta']) await clear(s);
}
