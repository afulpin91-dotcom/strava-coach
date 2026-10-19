// Boîte de réception personnelle (Cloudflare Workers + KV, gratuit).
// Un raccourci iPhone (ou une appli d'export) y DÉPOSE vos séances ; l'app les RÉCUPÈRE à l'ouverture.
//
// Réglages du Worker :
//   - KV namespace lié sous le nom  INBOX
//   - variable secrète  TOKEN           (≥ 16 caractères aléatoires : c'est votre mot de passe)
//   - variable          ALLOWED_ORIGIN  (ex. https://votre-nom.github.io — l'adresse de l'app, sans slash final)
//
// Routes (en-tête  Authorization: Bearer <TOKEN>) :
//   POST /ingest   { "workouts": [ { type, start, duration_s, distance_m, avg_hr?, elevation_m?, name?, hr? } ] }
//   GET  /pending  -> { "workouts": [ { key, ... } ] }
//   POST /ack      { "keys": [ "w:..." ] }   (efface ce que l'app a bien reçu)

const MAX_BODY = 300_000, MAX_WORKOUTS = 200, KEEP_SECONDS = 60 * 60 * 24 * 30;

const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

function sameSecret(a, b) { // comparaison en temps constant
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(String(v).replace(',', '.').trim()));

/** Valide et nettoie une séance ; retourne { w } ou { error }. Rien de ce qui est stocké n'est pris tel quel. */
export function cleanWorkout(x) {
  if (!x || typeof x !== 'object') return { error: 'séance invalide' };
  const type = String(x.type ?? x.name_type ?? '').trim().slice(0, 40);
  if (!type) return { error: 'type manquant' };
  const t = Date.parse(String(x.start ?? ''));
  if (!Number.isFinite(t) || t < Date.parse('2000-01-01') || t > Date.now() + 86_400_000) return { error: 'date de début invalide' };
  let duration = num(x.duration_s);
  if (!Number.isFinite(duration) && Number.isFinite(num(x.duration_min))) duration = num(x.duration_min) * 60;
  if (!Number.isFinite(duration) && x.end) duration = (Date.parse(String(x.end)) - t) / 1000;
  if (!Number.isFinite(duration) || duration < 120 || duration > 86_400) return { error: 'durée invalide (2 min à 24 h)' };
  let dist = num(x.distance_m);
  if (!Number.isFinite(dist) && Number.isFinite(num(x.distance_km))) dist = num(x.distance_km) * 1000;
  if (!Number.isFinite(dist)) dist = 0;
  if (dist < 0 || dist > 400_000) return { error: 'distance invalide' };
  const w = { type, start: new Date(t).toISOString().slice(0, 19) + 'Z', duration_s: Math.round(duration), distance_m: Math.round(dist) };
  const hr = num(x.avg_hr); if (Number.isFinite(hr) && hr >= 30 && hr <= 230) w.avg_hr = Math.round(hr * 10) / 10;
  const el = num(x.elevation_m); if (Number.isFinite(el) && el >= 0 && el <= 10_000) w.elevation_m = Math.round(el);
  if (x.name) w.name = String(x.name).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);
  if (Array.isArray(x.hr)) { // série de FC facultative : [[secondes depuis le début, bpm], …]
    const s = x.hr.slice(0, 6000).map(p => [num(p?.[0]), num(p?.[1])]).filter(([a, b]) => a >= 0 && a <= 86_400 && b >= 30 && b <= 230);
    if (s.length >= 30) w.hr = s.map(([a, b]) => [Math.round(a), Math.round(b)]);
  }
  return { w };
}

const keyOf = w => `w:${w.start}:${w.type.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = env.ALLOWED_ORIGIN ? { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' } : {};
    if (origin && origin !== env.ALLOWED_ORIGIN) return new Response('forbidden', { status: 403 }); // les navigateurs d'autres sites sont refusés
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!env.TOKEN || env.TOKEN.length < 16) return json({ error: 'TOKEN non configuré (16 caractères minimum)' }, 500, cors);
    if (!sameSecret(request.headers.get('Authorization') || '', `Bearer ${env.TOKEN}`)) return json({ error: 'non autorisé' }, 401, cors);
    const path = new URL(request.url).pathname;

    if (request.method === 'POST' && path === '/ingest') {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ error: 'requête trop grosse' }, 413, cors);
      let body; try { body = JSON.parse(raw); } catch { return json({ error: 'JSON invalide' }, 400, cors); }
      const list = Array.isArray(body) ? body : Array.isArray(body?.workouts) ? body.workouts : null;
      if (!list) return json({ error: 'champ « workouts » attendu' }, 400, cors);
      if (list.length > MAX_WORKOUTS) return json({ error: `${MAX_WORKOUTS} séances maximum par envoi` }, 400, cors);
      let accepted = 0, duplicates = 0; const rejected = [];
      for (let i = 0; i < list.length; i++) {
        const { w, error } = cleanWorkout(list[i]);
        if (error) { rejected.push({ index: i, reason: error }); continue; }
        const k = keyOf(w);
        if (await env.INBOX.get(k)) { duplicates++; continue; }
        await env.INBOX.put(k, JSON.stringify(w), { expirationTtl: KEEP_SECONDS });
        accepted++;
      }
      return json({ accepted, duplicates, rejected }, 200, cors);
    }

    if (request.method === 'GET' && path === '/pending') {
      const { keys } = await env.INBOX.list({ prefix: 'w:', limit: 100 });
      const out = [];
      for (const { name } of keys) { const v = await env.INBOX.get(name); if (v) out.push({ key: name, ...JSON.parse(v) }); }
      out.sort((a, b) => (a.start < b.start ? -1 : 1));
      return json({ workouts: out }, 200, cors);
    }

    if (request.method === 'POST' && path === '/ack') {
      let body; try { body = JSON.parse(await request.text()); } catch { return json({ error: 'JSON invalide' }, 400, cors); }
      const keys = (Array.isArray(body?.keys) ? body.keys : []).filter(k => typeof k === 'string' && k.startsWith('w:')).slice(0, 100);
      for (const k of keys) await env.INBOX.delete(k);
      return json({ deleted: keys.length }, 200, cors);
    }
    return json({ error: 'introuvable' }, 404, cors);
  },
};
