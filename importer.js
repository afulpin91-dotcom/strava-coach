// Import d'un export Strava (ZIP) ou de fichiers d'activité isolés : FIT, GPX, TCX, éventuellement en .gz.
// Tout est lu localement, rien n'est envoyé nulle part.

import { stableId } from './inbox.js';

const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z en secondes Unix

/* ---------- utilitaires ---------- */
async function inflate(bytes, format) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { throw new Error('décompression impossible (fichier corrompu ?)'); }
}
const toIso = unixSec => new Date(unixSec * 1000).toISOString().slice(0, 19) + 'Z';
const rad = d => d * Math.PI / 180;
function haversine(la1, lo1, la2, lo2) {
  const a = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** Dénivelé positif avec hystérésis (évite de compter le bruit du GPS/baromètre). */
function ascent(alts, threshold = 2) {
  let gain = 0, ref = null;
  for (const a of alts) {
    if (a == null) continue;
    if (ref == null) { ref = a; continue; }
    if (a - ref >= threshold) { gain += a - ref; ref = a; } else if (ref - a >= threshold) ref = a;
  }
  return gain;
}

export function sportName(raw, sub) {
  const s = String(raw ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (s === '1' || s === 'running' || s === 'run' || s === '9') return sub === 3 || sub === 'trail' ? 'TrailRun' : 'Run';
  if (s.includes('trail')) return 'TrailRun';
  if (s.includes('virtualrun')) return 'VirtualRun';
  if (s === '2' || s === 'cycling' || s === 'biking' || s === 'ride' || s === 'bike' || s === 'road') return 'Ride';
  if (s.includes('ride') || s.includes('cycl') || s.includes('bik')) return 'Ride';
  if (s === '11' || s === 'walking' || s === 'walk') return 'Walk';
  if (s === '17' || s === 'hiking' || s === 'hike') return 'Hike';
  if (s === '5' || s.includes('swim')) return 'Swim';
  return 'Workout';
}
const FIT_SPORT = { 1: 'running', 2: 'cycling', 5: 'swimming', 11: 'walking', 17: 'hiking' };

/* ---------- FIT ---------- */
const BASE = { 0: [1, 0xFF], 1: [1, 0x7F], 2: [1, 0xFF], 3: [2, 0x7FFF], 4: [2, 0xFFFF], 5: [4, 0x7FFFFFFF], 6: [4, 0xFFFFFFFF],
  7: [1, null], 8: [4, NaN], 9: [8, NaN], 10: [1, 0], 11: [2, 0], 12: [4, 0], 13: [1, 0xFF], 14: [8, null], 15: [8, null], 16: [8, null] };

function readField(dv, pos, size, base, le) {
  const spec = BASE[base];
  if (!spec || spec[1] === null || size < spec[0] || size % spec[0]) return null;
  let v;
  switch (base) {
    case 0: case 2: case 10: case 13: v = dv.getUint8(pos); break;
    case 1: v = dv.getInt8(pos); break;
    case 3: v = dv.getInt16(pos, le); break;
    case 4: case 11: v = dv.getUint16(pos, le); break;
    case 5: v = dv.getInt32(pos, le); break;
    case 6: case 12: v = dv.getUint32(pos, le); break;
    case 8: v = dv.getFloat32(pos, le); break;
    case 9: v = dv.getFloat64(pos, le); break;
    default: return null;
  }
  return v === spec[1] || Number.isNaN(v) ? null : v;
}

export function parseFit(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hdr = u8[0];
  if (hdr < 12 || String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) !== '.FIT') throw new Error('Fichier FIT invalide');
  const end = Math.min(hdr + dv.getUint32(4, true), u8.length);
  const defs = {}, recs = [], sessions = [];
  let pos = hdr, lastTs = 0;

  while (pos < end) {
    const h = u8[pos++];
    let local, compressedTs = null;
    if (h & 0x80) {
      local = (h >> 5) & 3;
      const off = h & 0x1f;
      let ts = (lastTs - (lastTs & 0x1f)) + off;
      if (off < (lastTs & 0x1f)) ts += 0x20;
      lastTs = compressedTs = ts;
    } else if (h & 0x40) { // définition de message
      local = h & 0x0f;
      pos++; // réservé
      const le = u8[pos++] === 0, global = dv.getUint16(pos, le); pos += 2;
      const n = u8[pos++], fields = [];
      for (let i = 0; i < n; i++) { fields.push({ num: u8[pos], size: u8[pos + 1], base: u8[pos + 2] & 0x1f }); pos += 3; }
      let devSize = 0;
      if (h & 0x20) { const nd = u8[pos++]; for (let i = 0; i < nd; i++) { devSize += u8[pos + 1]; pos += 3; } }
      defs[local] = { global, le, fields, devSize };
      continue;
    } else local = h & 0x0f;

    const d = defs[local];
    if (!d) throw new Error('FIT corrompu (définition manquante)');
    const msg = {};
    for (const f of d.fields) { msg[f.num] = readField(dv, pos, f.size, f.base, d.le); pos += f.size; }
    pos += d.devSize;
    if (compressedTs != null) msg[253] = compressedTs;
    if (msg[253] != null) lastTs = msg[253];
    if (d.global === 20) recs.push(msg); else if (d.global === 18) sessions.push(msg);
  }

  const first = recs.find(r => r[253] != null), last = [...recs].reverse().find(r => r[253] != null);
  const hr = recs.filter(r => r[253] != null && r[3]).map(r => [r[253] + FIT_EPOCH, r[3]]);
  let out;
  if (sessions.length) {
    const s0 = sessions[0], sum = k => sessions.reduce((a, s) => a + (s[k] || 0), 0);
    const timer = sum(8) / 1000, w = sessions.reduce((a, s) => a + (s[16] ? s[16] * (s[8] || 1) : 0), 0);
    out = {
      sport: FIT_SPORT[s0[5]] ?? s0[5], sub: s0[6], start: (s0[2] ?? s0[253] ?? first?.[253]) + FIT_EPOCH,
      distance_m: sum(9) / 100, elapsed_s: sum(7) / 1000 || timer, moving_s: timer || sum(7) / 1000,
      ascent: sum(22) || null, avg_hr: w && timer ? w / sessions.reduce((a, s) => a + (s[16] ? (s[8] || 1) : 0), 0) : null,
    };
  } else if (first) {
    const alts = recs.map(r => (r[78] != null ? r[78] / 5 - 500 : r[2] != null ? r[2] / 5 - 500 : null));
    out = { sport: null, sub: null, start: first[253] + FIT_EPOCH, distance_m: (last[5] || 0) / 100, elapsed_s: last[253] - first[253],
      moving_s: last[253] - first[253], ascent: ascent(alts), avg_hr: null };
  } else throw new Error('FIT sans données d\'activité');
  if (out.avg_hr == null && hr.length) out.avg_hr = hr.reduce((a, x) => a + x[1], 0) / hr.length;
  out.hr = hr;
  return out;
}

/* ---------- GPX / TCX (extraction par expressions régulières : formats très réguliers) ---------- */
const tag = (s, name) => { const m = s.match(new RegExp(`<${name}>([^<]*)</${name}>`)); return m ? m[1].trim() : null; };
const decodeXml = s => (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function fromPoints(pts, sport, name) {
  // pts : { t (s Unix), lat, lon, ele, hr, dist? }
  const p = pts.filter(x => Number.isFinite(x.t));
  if (p.length < 2) throw new Error('trace vide');
  let dist = 0, moving = 0;
  for (let i = 1; i < p.length; i++) {
    const dt = p[i].t - p[i - 1].t;
    const dd = p[i].dist != null && p[i - 1].dist != null ? p[i].dist - p[i - 1].dist
      : p[i].lat != null && p[i - 1].lat != null ? haversine(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon) : 0;
    dist += Math.max(dd, 0);
    if (dt > 0 && dt <= 30 && dd / dt >= 0.5) moving += dt;
  }
  const hr = p.filter(x => x.hr).map(x => [x.t, x.hr]);
  const elapsed = p[p.length - 1].t - p[0].t;
  return {
    sport, sub: null, name, start: p[0].t, distance_m: dist, elapsed_s: elapsed, moving_s: moving || elapsed,
    ascent: ascent(p.map(x => x.ele)), avg_hr: hr.length ? hr.reduce((a, x) => a + x[1], 0) / hr.length : null, hr,
  };
}

export function parseGpx(text) {
  const trk = text.slice(text.indexOf('<trk>') >= 0 ? text.indexOf('<trk>') : 0);
  const name = decodeXml(tag(trk, 'name')), type = tag(trk, 'type');
  const pts = [];
  const re = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  let m;
  while ((m = re.exec(trk))) {
    const body = m[3], ele = tag(body, 'ele'), time = tag(body, 'time'), hr = body.match(/<(?:\w+:)?hr>(\d+)</);
    pts.push({ lat: +m[1], lon: +m[2], ele: ele == null ? null : +ele, t: time ? Date.parse(time) / 1000 : NaN, hr: hr ? +hr[1] : null });
  }
  return fromPoints(pts, type, name && name !== 'TODO' ? name : null);
}

export function parseTcx(text) {
  const sport = (text.match(/<Activity\s+Sport="([^"]+)"/) || [])[1];
  const pts = [];
  const re = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/g;
  let m;
  while ((m = re.exec(text))) {
    const b = m[1], time = tag(b, 'Time'), alt = tag(b, 'AltitudeMeters'), dist = tag(b, 'DistanceMeters');
    const hr = b.match(/<HeartRateBpm[^>]*>\s*<Value>(\d+)</);
    const pos = b.match(/<LatitudeDegrees>([^<]+)<[\s\S]*?<LongitudeDegrees>([^<]+)</);
    pts.push({ t: time ? Date.parse(time) / 1000 : NaN, ele: alt == null ? null : +alt, dist: dist == null ? null : +dist,
      hr: hr ? +hr[1] : null, lat: pos ? +pos[1] : null, lon: pos ? +pos[2] : null });
  }
  return fromPoints(pts, sport, null);
}

/* ---------- fichier -> { activity, stream } ---------- */
export const idFromName = name => { const m = name.match(/(\d{5,})\.(?:fit|gpx|tcx)(?:\.gz)?$/i); return m ? Number(m[1]) : null; };

export async function parseActivityFile(name, bytes) {
  let n = name.toLowerCase();
  if (n.endsWith('.gz')) { bytes = await inflate(bytes, 'gzip'); n = n.slice(0, -3); }
  let p;
  if (n.endsWith('.fit')) p = parseFit(bytes);
  else if (n.endsWith('.gpx')) p = parseGpx(new TextDecoder().decode(bytes));
  else if (n.endsWith('.tcx')) p = parseTcx(new TextDecoder().decode(bytes));
  else return null;

  const sport = sportName(p.sport, p.sub);
  const start = toIso(p.start);
  // Archive Strava : le nom du fichier est le numéro d'activité. Fichier téléchargé à l'unité (nom libre) : identifiant stable tiré de l'heure de début.
  const id = idFromName(name) ?? stableId(`${start}|file`);
  const activity = {
    id, name: p.name || `${{ Run: 'Course à pied', TrailRun: 'Trail', Ride: 'Vélo', Walk: 'Marche', Hike: 'Randonnée', Swim: 'Natation' }[sport] || 'Séance'} du ${start.slice(0, 10)}`,
    sport, start_date: start, distance_m: Math.round(p.distance_m), moving_s: Math.round(p.moving_s), elevation_m: p.ascent == null ? null : Math.round(p.ascent),
    avg_hr: p.avg_hr ? Math.round(p.avg_hr * 10) / 10 : null, avg_speed: p.moving_s ? Math.round(p.distance_m / p.moving_s * 1000) / 1000 : null,
    perceived_exertion: null, workout_type: null, source: 'export',
  };
  let stream = null;
  if (p.hr.length >= 30) { // échantillonnage à ~5 s : suffisant pour les zones, 5 fois moins lourd
    const time = [], heartrate = [];
    let next = -Infinity;
    for (const [t, bpm] of p.hr) if (t >= next) { time.push(Math.round(t - p.start)); heartrate.push(bpm); next = t + 5; }
    stream = { id, time, heartrate };
  }
  return { activity, stream };
}

/* ---------- ZIP (lecture directe, sans tout charger en mémoire) ---------- */
export async function listZip(blob) {
  const tailLen = Math.min(blob.size, 65557 + 22);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Ce fichier n\'est pas une archive ZIP valide.');
  let count = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOff = tail.getUint32(e + 16, true);
  if (cdOff === 0xFFFFFFFF || count === 0xFFFF) { // ZIP64
    const loc = new DataView(await blob.slice(blob.size - tailLen + e - 20, blob.size - tailLen + e).arrayBuffer());
    if (loc.getUint32(0, true) !== 0x07064b50) throw new Error('Archive ZIP64 non reconnue.');
    const z = new DataView(await blob.slice(Number(loc.getBigUint64(8, true)), Number(loc.getBigUint64(8, true)) + 56).arrayBuffer());
    count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
  }
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), bytes = new Uint8Array(cd.buffer);
  const out = [], dec = new TextDecoder();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true), nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), comLen = cd.getUint16(p + 32, true);
    let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true), off = cd.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    for (let x = p + 46 + nameLen, xe = x + extraLen; x + 4 <= xe;) { // champs ZIP64
      const id = cd.getUint16(x, true), sz = cd.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xFFFFFFFF) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (csize === 0xFFFFFFFF) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (off === 0xFFFFFFFF) off = Number(cd.getBigUint64(q, true));
      }
      x += 4 + sz;
    }
    out.push({ name, method, csize, usize, off });
    p += 46 + nameLen + extraLen + comLen;
  }
  return out;
}

export async function readZipEntry(blob, e) {
  const lh = new DataView(await blob.slice(e.off, e.off + 30).arrayBuffer());
  const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const raw = new Uint8Array(await blob.slice(start, start + e.csize).arrayBuffer());
  if (e.method === 0) return raw;
  if (e.method === 8) return inflate(raw, 'deflate-raw');
  throw new Error(`méthode de compression ZIP ${e.method} non gérée`);
}

/**
 * Importe une liste de fichiers (un ZIP d'export, ou des fichiers FIT/GPX/TCX isolés).
 * `store(activities, streams)` enregistre un lot ; `onProgress(texte)` informe l'utilisateur.
 */
export async function importFiles(files, store, onProgress = () => {}) {
  const jobs = []; // { name, read: () => Promise<Uint8Array> }
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (n.endsWith('.zip')) {
      const entries = await listZip(f);
      for (const e of entries) if (/\.(fit|gpx|tcx)(\.gz)?$/i.test(e.name) && !e.name.endsWith('/') && !/(^|\/)__MACOSX\//.test(e.name)) jobs.push({ name: e.name, read: () => readZipEntry(f, e) });
    } else if (/\.(fit|gpx|tcx)(\.gz)?$/.test(n)) jobs.push({ name: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) });
  }
  const stats = { found: jobs.length, imported: 0, withHr: 0, skipped: 0, errors: [] };
  let acts = [], streams = [];
  const flush = async () => { if (acts.length) await store(acts, streams); acts = []; streams = []; };
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    try {
      const r = await parseActivityFile(j.name, await j.read());
      if (!r) { stats.skipped++; continue; }
      acts.push(r.activity); stats.imported++;
      if (r.stream) { streams.push(r.stream); stats.withHr++; }
    } catch (e) { stats.skipped++; if (stats.errors.length < 5) stats.errors.push(`${j.name.split('/').pop()} : ${e.message}`); }
    if (acts.length >= 40) await flush();
    if (i % 10 === 0) onProgress(`Import : ${i + 1}/${jobs.length} fichiers…`);
    if (i % 25 === 0) await new Promise(r => setTimeout(r)); // laisse respirer l'interface
  }
  await flush();
  return stats;
}
