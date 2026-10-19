// Connexion à Strava depuis le navigateur : OAuth, synchronisation, zones.
import * as db from './db.js';

const STRAVA = 'https://www.strava.com';
export class StravaError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

export const redirectUri = () => location.origin + location.pathname;

export function authorizeUrl(s) {
  const q = new URLSearchParams({
    client_id: s.clientId, response_type: 'code', redirect_uri: redirectUri(),
    approval_prompt: 'auto', scope: 'read,activity:read_all,profile:read_all',
  });
  return `${STRAVA}/oauth/authorize?${q}`;
}

const apiBase = s => (s.relayUrl ? s.relayUrl.replace(/\/$/, '') + '/api' : STRAVA + '/api/v3');

async function tokenRequest(s, params) {
  let res;
  try {
    if (s.relayUrl) {
      res = await fetch(s.relayUrl.replace(/\/$/, '') + '/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      });
    } else {
      if (!s.clientId || !s.clientSecret) throw new StravaError('Renseignez le Client ID et le Client Secret dans Réglages.', 'config');
      res = await fetch(`${STRAVA}/oauth/token`, {
        method: 'POST', body: new URLSearchParams({ client_id: s.clientId, client_secret: s.clientSecret, ...params }),
      });
    }
  } catch (e) {
    if (e instanceof StravaError) throw e;
    throw new StravaError(s.relayUrl
      ? 'Relais injoignable : vérifiez son adresse.'
      : 'Le navigateur a bloqué la requête vers Strava (CORS) ou vous êtes hors ligne. Configurez le relais dans Réglages.', 'network');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new StravaError(`Strava a refusé l'échange (${res.status}). ${j.message || ''} Vérifiez Client ID/Secret et le code.`, 'auth');
  await db.setMeta('tokens', { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at });
  return j;
}

export const exchangeCode = (s, code) => tokenRequest(s, { grant_type: 'authorization_code', code });

async function accessToken(s) {
  const t = await db.getMeta('tokens');
  if (!t) throw new StravaError("Pas connecté à Strava : ouvrez Réglages > Se connecter.", 'auth');
  if (t.expires_at - 60 > Date.now() / 1000) return t.access_token;
  return (await tokenRequest(s, { grant_type: 'refresh_token', refresh_token: t.refresh_token })).access_token;
}

async function api(s, path, params = {}) {
  const token = await accessToken(s);
  const url = `${apiBase(s)}${path}?${new URLSearchParams(params)}`;
  let res;
  try { res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); }
  catch { throw new StravaError("Impossible de joindre Strava (CORS ou hors ligne). Configurez le relais dans Réglages.", 'network'); }
  if (res.status === 429) throw new StravaError('Limite Strava atteinte (100 requêtes / 15 min). Progression sauvegardée : réessayez dans un quart d\'heure.', 'rate');
  if (res.status === 401) throw new StravaError('Accès refusé : reconnectez-vous à Strava (Réglages). Vérifiez que « Voir toutes vos activités » est coché.', 'auth');
  if (!res.ok) throw new StravaError(`Erreur Strava ${res.status}.`, 'http');
  return res.json();
}

const simplify = a => ({
  id: a.id, name: a.name, sport: a.sport_type || a.type, start_date: a.start_date, distance_m: a.distance,
  moving_s: a.moving_time, elevation_m: a.total_elevation_gain, avg_hr: a.average_heartrate, avg_speed: a.average_speed,
  perceived_exertion: a.perceived_exertion, workout_type: a.workout_type,
});

export async function syncActivities(s, onProgress = () => {}) {
  const acts = await db.getAll('activities');
  const last = acts.reduce((m, a) => (a.start_date > m ? a.start_date : m), '');
  const after = last ? Math.floor(Date.parse(last) / 1000) : 0;
  let page = 1, total = 0;
  for (;;) {
    const batch = await api(s, '/athlete/activities', { after, per_page: 200, page });
    if (!batch.length) break;
    await db.putMany('activities', batch.map(simplify));
    total += batch.length; page++;
    onProgress(`${total} activité(s) récupérée(s)…`);
  }
  return total;
}

export async function syncStreams(s, limit, onProgress = () => {}) {
  const [acts, have] = await Promise.all([db.getAll('activities'), db.getAll('streams')]);
  const done = new Set(have.map(x => x.id));
  const todo = acts.filter(a => !done.has(a.id)).sort((a, b) => (a.start_date < b.start_date ? 1 : -1)).slice(0, limit);
  let n = 0;
  for (const a of todo) {
    let rec = { id: a.id };
    try {
      const st = await api(s, `/activities/${a.id}/streams`, { keys: 'time,heartrate', key_by_type: 'true' });
      if (st.time && st.heartrate) rec = { id: a.id, time: st.time.data, heartrate: st.heartrate.data };
    } catch (e) { if (e.kind === 'rate' || e.kind === 'auth' || e.kind === 'network') throw e; }
    await db.put('streams', rec);
    onProgress(`Détails FC : ${++n}/${todo.length}`);
  }
  return todo.length;
}

export async function syncZones(s) {
  try {
    const z = (await api(s, '/athlete/zones')).heart_rate?.zones;
    if (z?.length) await db.setMeta('hr_zones', z);
  } catch (e) { if (e.kind === 'rate') throw e; }
}

/** Teste si Strava accepte les appels depuis ce navigateur (CORS), sans rien envoyer de secret. */
export async function testDirect() {
  try {
    const r = await fetch(`${STRAVA}/oauth/token`, { method: 'POST', body: new URLSearchParams({ client_id: '0', client_secret: 'x', code: 'x', grant_type: 'authorization_code' }) });
    return { ok: true, status: r.status };
  } catch { return { ok: false }; }
}
