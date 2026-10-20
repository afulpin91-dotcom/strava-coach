// Plan de course : allure à viser sur chaque kilomètre pour tenir le temps visé.
// Le total est toujours exactement le temps visé ; la stratégie répartit l'effort, le profil du parcours (GPX) l'ajuste aux côtes.

export const STRATEGIES = {
  progressive: 'Progressif — départ prudent, on accélère un peu (recommandé)',
  even: 'Régulier — même allure partout',
  cautious: 'Très prudent — 1er tronçon lent, finale plus vite',
};
// Pondération de l'allure selon la position x dans la course (0 = départ, 1 = arrivée) ; normalisée ensuite.
const SHAPE = {
  even: () => 1,
  progressive: x => 1.03 - 0.05 * x,                       // départ ~3 % plus lent, arrivée ~2 % plus rapide
  cautious: x => (x < 0.07 ? 1.04 : x > 0.9 ? 0.975 : 1),
};

/* ---------- profil du parcours ---------- */
const rad = d => d * Math.PI / 180;
const haversine = (a, b, c, d) => 12742000 * Math.asin(Math.min(1, Math.sqrt(Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2)));
const tag = (s, name) => { const m = s.match(new RegExp(`<${name}>([^<]*)</${name}>`)); return m ? m[1].trim() : null; };

/** Lit un GPX de parcours (trace ou itinéraire) : distance, dénivelé et altitude tous les 100 m. */
export function courseProfileFromGpx(text) {
  const pts = [], re = /<(?:trkpt|rtept)\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/(?:trkpt|rtept)>/g;
  let m;
  while ((m = re.exec(text))) { const e = tag(m[3], 'ele'); pts.push({ lat: +m[1], lon: +m[2], ele: e === null ? NaN : +e }); }
  if (pts.length < 10) throw new Error('GPX trop court ou illisible (il faut au moins 10 points).');
  if (pts.filter(p => Number.isFinite(p.ele)).length < pts.length * 0.8) throw new Error("Ce GPX n'a pas d'altitude : impossible d'en tirer le profil.");
  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  const total = dist[dist.length - 1];
  if (total < 1000) throw new Error('Parcours de moins de 1 km : GPX inadapté.');
  // altitude rééchantillonnée tous les 50 m, puis lissée sur ~250 m (le bruit du GPS/baromètre fausse sinon les pentes)
  const ele = []; let j = 0, last = pts.find(p => Number.isFinite(p.ele)).ele;
  for (let d = 0; d <= total; d += 50) {
    while (j < dist.length - 2 && dist[j + 1] < d) j++;
    const a = pts[j], b = pts[j + 1], t = dist[j + 1] > dist[j] ? (d - dist[j]) / (dist[j + 1] - dist[j]) : 0;
    const ea = Number.isFinite(a.ele) ? a.ele : last, eb = Number.isFinite(b.ele) ? b.ele : ea;
    last = ea + (eb - ea) * Math.min(Math.max(t, 0), 1); ele.push(last);
  }
  const sm = ele.map((_, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - 2); k <= Math.min(ele.length - 1, i + 2); k++) { s += ele[k]; n++; } return s / n; });
  let gain = 0, loss = 0;
  for (let i = 1; i < sm.length; i++) { const d = sm[i] - sm[i - 1]; if (d > 0) gain += d; else loss -= d; }
  const points = []; for (let i = 0; i < sm.length; i += 2) points.push([Math.round(i * 50) / 1000, Math.round(sm[i] * 10) / 10]);
  return { name: tag(text.slice(Math.max(text.indexOf('<name>'), 0)), 'name') || 'Parcours', length_km: Math.round(total) / 1000, gain_m: Math.round(gain), loss_m: Math.round(loss), points };
}

const eleAt = (pts, km) => { // interpolation linéaire de l'altitude
  if (km <= pts[0][0]) return pts[0][1]; if (km >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  let lo = 0, hi = pts.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= km) lo = mid; else hi = mid; }
  const t = (km - pts[lo][0]) / (pts[hi][0] - pts[lo][0]); return pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t;
};

/** Effet d'une pente (fraction, ex. 0.05) sur l'allure à effort égal : coût énergétique de Minetti, atténué et borné.
 *  Ordre de grandeur : +5 % ≈ +18 % de temps, −5 % ≈ −14 %. */
export function gradeFactor(g) {
  const i = Math.min(Math.max(g, -0.2), 0.2), c = 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
  return Math.min(Math.max(1 + 0.6 * (c / 3.6 - 1), 0.88), 1.35);
}

/* ---------- plan par kilomètre ---------- */
/** g : { distance_km, target_s } ; profile : résultat de courseProfileFromGpx (facultatif). */
export function racePlan(g, strategy = 'progressive', profile = null) {
  const D = g.distance_km, T = g.target_s, shape = SHAPE[strategy] || SHAPE.even, rows = [];
  const scale = profile ? profile.length_km / D : 1;
  for (let from = 0, i = 1; from < D - 1e-9; i++) {
    const to = Math.min(from + 1, D), d = to - from;
    let grade = null, f = 1;
    if (profile) { const a = from * scale, b = to * scale; grade = (eleAt(profile.points, b) - eleAt(profile.points, a)) / ((b - a) * 1000); f = gradeFactor(grade); }
    rows.push({ km: i, from, to, d, grade, w: shape((from + to) / 2 / D) * f });
    from = to;
  }
  const base = T / rows.reduce((s, r) => s + r.d * r.w, 0);          // allure (s/km) pour une pondération de 1
  let cum = 0;
  for (const r of rows) { r.pace = base * r.w; r.split = r.pace * r.d; cum += r.split; r.cum = cum; r.label = r.d > 0.999 ? `Km ${r.km}` : `Arrivée (${Math.round(r.d * 1000)} m)`; }
  rows[rows.length - 1].cum = T;
  const paces = rows.filter(r => r.d > 0.999).map(r => r.pace);
  return { rows, avg_pace: T / D, first: rows[0].pace, last: rows.filter(r => r.d > 0.999).pop()?.pace ?? rows[0].pace, fastest: Math.min(...paces), slowest: Math.max(...paces),
    warning: profile && Math.abs(scale - 1) > 0.08 ? `Le parcours GPX fait ${profile.length_km} km pour une course de ${D} km : le profil est étiré sur la distance de la course.` : null };
}

/** Temps cumulé (s) à une distance donnée, interpolé dans le kilomètre concerné. */
export function timeAt(plan, km) {
  let prev = 0;
  for (const r of plan.rows) { if (km <= r.to + 1e-9) return prev + (r.cum - prev) * ((km - r.from) / r.d); prev = r.cum; }
  return plan.rows[plan.rows.length - 1].cum;
}

export const fmtPaceS = s => { let m = Math.floor(s / 60), r = Math.round(s % 60); if (r === 60) { m++; r = 0; } return `${m}:${String(r).padStart(2, '0')}`; };
export const fmtClock = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`; };

/** Passages utiles : tous les 5 km, le semi pour un marathon, l'arrivée. */
export function checkpoints(plan, D) {
  const out = []; for (let k = 5; k < D - 0.5; k += 5) out.push([k, timeAt(plan, k)]);
  if (D > 30 && D < 43) out.push([21.0975, timeAt(plan, 21.0975)]);
  out.push([D, timeAt(plan, D)]); return out.sort((a, b) => a[0] - b[0]);
}

/** Version texte, à coller dans Notes ou à garder dans une capture. */
export function racePlanText(g, plan, strategyName) {
  const head = `${g.name} — ${g.distance_km} km en ${fmtClock(g.target_s)} (${fmtPaceS(plan.avg_pace)}/km) · ${strategyName}`;
  const lines = plan.rows.map(r => `${r.label.padEnd(18)} ${fmtPaceS(r.pace)}/km   → ${fmtClock(r.cum)}${r.grade != null ? `   (${(r.grade * 100).toFixed(1)} %)` : ''}`);
  const cps = checkpoints(plan, g.distance_km).map(([k, t]) => `${Number.isInteger(k) ? k : k === g.distance_km ? g.distance_km : 'semi'} km : ${fmtClock(t)}`).join(' · ');
  return [head, '', ...lines, '', 'Passages : ' + cps].join('\n');
}
