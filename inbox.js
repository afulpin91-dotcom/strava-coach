// Synchro automatique : l'app récupère, à l'ouverture, les séances déposées dans VOTRE boîte de réception
// (voir inbox/worker.js). Rien n'est envoyé ni récupéré tant que l'adresse et le code ne sont pas renseignés.

/** Identifiant numérique stable (52 bits) à partir de « début|type » : une même séance reçue deux fois a le même id. */
export function stableId(text) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x85ebca6b) >>> 0; b ^= b >>> 13; }
  return (a & 0xfffff) * 4294967296 + (b >>> 0);
}

export function sportOf(type) {
  const t = String(type).toLowerCase();
  if (/trail/.test(t)) return 'TrailRun';
  if (/run|course|jogg/.test(t)) return 'Run';
  if (/hik|rando/.test(t)) return 'Hike';
  if (/walk|marche/.test(t)) return 'Walk';
  if (/cycl|bik|ride|v[ée]lo/.test(t)) return 'Ride';
  if (/swim|nata/.test(t)) return 'Swim';
  return 'Workout';
}
const LABEL = { Run: 'Course à pied', TrailRun: 'Trail', Ride: 'Vélo', Walk: 'Marche', Hike: 'Randonnée', Swim: 'Natation', Workout: 'Séance' };

/** Séance de la boîte -> activité de l'app (+ flux de FC si fourni). */
export function workoutToActivity(w) {
  const sport = sportOf(w.type), id = stableId(`${w.start}|${w.type}`);
  const activity = {
    id, name: w.name || `${LABEL[sport]} (Santé) du ${w.start.slice(0, 10)}`, sport, start_date: w.start, distance_m: w.distance_m, moving_s: w.duration_s,
    elevation_m: w.elevation_m ?? null, avg_hr: w.avg_hr ?? null, avg_speed: w.duration_s ? Math.round(w.distance_m / w.duration_s * 1000) / 1000 : null,
    perceived_exertion: null, workout_type: null, source: 'inbox',
  };
  let stream = null;
  if (Array.isArray(w.hr) && w.hr.length >= 30) {
    const time = [], heartrate = []; let next = -Infinity;
    for (const [t, bpm] of w.hr) if (t >= next) { time.push(t); heartrate.push(bpm); next = t + 5; }
    stream = { id, time, heartrate };
    if (activity.avg_hr == null) activity.avg_hr = Math.round(heartrate.reduce((a, x) => a + x, 0) / heartrate.length * 10) / 10;
  }
  return { activity, stream };
}

/** Même séance déjà connue (autre source : export Strava, saisie…) ? Début à 5 min près et distance à ±5 % (300 m mini). */
export function isDuplicate(acts, a) {
  const t = Date.parse(a.start_date);
  return acts.some(x => x.id === a.id || (Math.abs(Date.parse(x.start_date) - t) <= 300_000
    && Math.abs((x.distance_m || 0) - a.distance_m) <= Math.max(300, 0.05 * a.distance_m)));
}

export const validInboxUrl = u => /^https:\/\/[^\s/]+/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(u);

/**
 * Récupère les séances en attente, enregistre les nouvelles, puis accuse réception (la boîte se vide).
 * `store(activities, streams)` écrit dans la base locale ; `existing` : activités déjà connues.
 */
export async function pullInbox({ url, token }, existing, store, fetchImpl = fetch) {
  if (!validInboxUrl(url) || !token) throw new Error("Adresse de la boîte (https://…) ou code manquant dans Réglages.");
  const base = url.replace(/\/+$/, ''), headers = { Authorization: `Bearer ${token}` };
  let res;
  try { res = await fetchImpl(`${base}/pending`, { headers }); } catch { throw new Error('Boîte de réception injoignable (connexion ou adresse).'); }
  if (res.status === 401) throw new Error('Code refusé par la boîte : vérifiez le code dans Réglages.');
  if (!res.ok) throw new Error(`Boîte de réception : erreur ${res.status}.`);
  const { workouts = [] } = await res.json(), known = [...existing], fresh = [], streams = [], seen = [];
  for (const w of workouts) {
    seen.push(w.key);
    if (!w.start || !w.type || !(w.duration_s > 0)) continue;
    const { activity, stream } = workoutToActivity(w);
    if (isDuplicate(known, activity)) continue;
    fresh.push(activity); known.push(activity); if (stream) streams.push(stream);
  }
  if (fresh.length) await store(fresh, streams);
  if (seen.length) { try { await fetchImpl(`${base}/ack`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: seen }) }); } catch { /* sera renvoyé la prochaine fois : sans danger, les doublons sont ignorés */ } }
  return { received: workouts.length, imported: fresh.length, duplicates: workouts.length - fresh.length };
}
