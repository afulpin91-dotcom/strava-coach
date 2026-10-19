// Moteur d'entraînement : port JavaScript de strava_coach (analysis, zones, vdot, plan).
// Fonctions pures : elles reçoivent un contexte { acts, streams, meta, cfg } et une date (« AAAA-MM-JJ »).
//   acts    : activités triées par start_date croissant
//   streams : { [activityId]: { time:[...], heartrate:[...] } }
//   meta    : { hr_zones, goal, plan, manual_races }
//   cfg     : { fcMax, fcRepos, fcZones:[] }

export const RUN = new Set(['Run', 'TrailRun', 'VirtualRun']);
export const ZONE_NAMES = ['Z1 récup', 'Z2 endurance', 'Z3 tempo', 'Z4 seuil', 'Z5 VO2max'];

/* ---------- dates (UTC, chaînes ISO) ---------- */
const DAY = 86400000;
const pd = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const iso = ms => new Date(ms).toISOString().slice(0, 10);
export const addDays = (s, n) => iso(pd(s) + n * DAY);
export const diffDays = (a, b) => Math.round((pd(a) - pd(b)) / DAY);
export const weekday = s => (new Date(pd(s)).getUTCDay() + 6) % 7; // lundi = 0
export const mondayOf = s => addDays(s, -weekday(s));
export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** Arrondi identique à Python : une égalité exacte (ex. 38.25) va au pair, comme round(). */
export function rnd(x, nd = 0) {
  const p = 10 ** nd, y = x * p;
  if (Number.isInteger(x * 2 ** (nd + 1)) && Math.abs(y - Math.floor(y) - 0.5) < 1e-9) {
    const f = Math.floor(y);
    return (f % 2 === 0 ? f : f + 1) / p;
  }
  return Number(x.toFixed(nd)); // toFixed arrondit d'après la valeur binaire exacte, comme Python
}
const r1 = x => rnd(x, 1);
/** Affichage d'un flottant comme Python : 13 -> « 13.0 ». */
const fl = x => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const dayOf = a => a.start_date.slice(0, 10);
const sum = (xs, f = x => x) => xs.reduce((s, x) => s + f(x), 0);

/* ---------- VDOT (Daniels) ---------- */
const vo2 = v => -4.60 + 0.182258 * v + 0.000104 * v * v;
const pct = t => 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
export const vdot = (distM, timeS) => { const t = timeS / 60; return vo2(distM / t) / pct(t); };
export function paceAt(vd, frac) {
  const c = -(4.60 + vd * frac), a = 0.000104, b = 0.182258;
  const v = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  return 1000 / v * 60;
}
export const trainingPaces = vd => ({ E: paceAt(vd, 0.65), M: paceAt(vd, 0.80), T: paceAt(vd, 0.88), I: paceAt(vd, 0.975) });
export function predictTime(vd, distM) {
  let lo = 60, hi = 8 * 3600;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (vdot(distM, mid) > vd) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export function fmtPace(s) {
  let m = Math.floor(s / 60), r = rnd(s % 60);
  if (r === 60) { m += 1; r = 0; }
  return `${m}:${String(r).padStart(2, '0')}/km`;
}
export function fmtTime(s) {
  s = rnd(s);
  const h = Math.floor(s / 3600), r = s % 3600, mm = String(Math.floor(r / 60)).padStart(2, '0'), ss = String(r % 60).padStart(2, '0');
  return h ? `${h}h${mm}'${ss}` : `${Math.floor(r / 60)}'${ss}`;
}
export function parseTime(txt) {
  const p = txt.split(':').map(Number);
  while (p.length < 3) p.unshift(0);
  return p[0] * 3600 + p[1] * 60 + p[2];
}

/* ---------- analyse ---------- */
const loadRows = (ctx, since) => ctx.acts.filter(a => a.start_date >= since);

export function trimp(a, cfg) {
  const minutes = (a.moving_s || 0) / 60;
  if (a.avg_hr) {
    let x = (a.avg_hr - cfg.fcRepos) / Math.max(cfg.fcMax - cfg.fcRepos, 1);
    x = Math.min(Math.max(x, 0), 1);
    return minutes * x * 0.64 * Math.exp(1.92 * x);
  }
  return minutes * 0.5;
}

export function dailyLoad(ctx, days, today) {
  const since = addDays(today, -days), d = {};
  for (const a of loadRows(ctx, since)) d[dayOf(a)] = (d[dayOf(a)] || 0) + trimp(a, ctx.cfg);
  return Array.from({ length: days + 1 }, (_, i) => { const k = addDays(since, i); return [k, d[k] || 0]; });
}

export function fitnessForm(ctx, today) {
  let ctl = 0, atl = 0;
  for (const [, v] of dailyLoad(ctx, 180, today)) { ctl += (v - ctl) / 42; atl += (v - atl) / 7; }
  return { ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl) };
}

export function fitnessSeries(ctx, days, today) {
  let ctl = 0, atl = 0;
  const out = dailyLoad(ctx, 180 + days, today).map(([date, v]) => {
    ctl += (v - ctl) / 42; atl += (v - atl) / 7;
    return { date, ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl) };
  });
  return out.slice(-days);
}

export function weekly(ctx, weeks, today) {
  const monday = mondayOf(today), out = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = addDays(monday, -7 * w), end = addDays(start, 7);
    const rows = loadRows(ctx, start).filter(a => dayOf(a) < end);
    const runs = rows.filter(a => RUN.has(a.sport));
    out.push({
      semaine: start, seances: rows.length,
      heures: r1(sum(rows, a => a.moving_s || 0) / 3600),
      km_course: r1(sum(runs, a => a.distance_m || 0) / 1000),
      d_plus_m: rnd(sum(rows, a => a.elevation_m || 0)),
      charge: rnd(sum(rows, a => trimp(a, ctx.cfg))),
    });
  }
  return out;
}

export function acwr(ctx, today) {
  const d = dailyLoad(ctx, 28, today).map(x => x[1]).slice(-28);
  const chronic = sum(d) / 4;
  return chronic ? rnd(sum(d.slice(-7)) / chronic, 2) : null;
}

export function pace(speed) {
  if (!speed) return null;
  const s = 1000 / speed;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}/km`;
}

export function recentActivities(ctx, n = 10) {
  return [...ctx.acts].reverse().slice(0, n).map(a => ({
    date: dayOf(a), sport: a.sport, nom: a.name,
    km: r1((a.distance_m || 0) / 1000), duree_min: rnd((a.moving_s || 0) / 60),
    allure: RUN.has(a.sport) ? pace(a.avg_speed) : null,
    fc_moy: a.avg_hr ?? null, d_plus: a.elevation_m ?? null, effort_percu: a.perceived_exertion ?? null,
  }));
}

/* ---------- zones de FC ---------- */
export function zoneBounds(ctx) {
  const c = ctx.cfg;
  if (c.fcZones && c.fcZones.length === 4) return [c.fcZones, 'manuel'];
  const z = ctx.meta.hr_zones;
  if (z && z.length >= 5 && z.slice(0, 4).every(x => (x.max || 0) > 0)) return [z.slice(0, 4).map(x => x.max), 'Strava'];
  const res = c.fcMax - c.fcRepos;
  return [[0.6, 0.7, 0.8, 0.9].map(p => rnd(c.fcRepos + res * p)), 'Karvonen'];
}
const zoneOf = (hr, b) => { for (let i = 0; i < b.length; i++) if (hr < b[i]) return i; return 4; };

function activityMinutes(ctx, a, b) {
  const z = [0, 0, 0, 0, 0], s = ctx.streams[a.id];
  if (s && s.heartrate && s.time) {
    for (let i = 1; i < s.time.length; i++) z[zoneOf(s.heartrate[i], b)] += Math.min(s.time[i] - s.time[i - 1], 30) / 60;
    return [z, true];
  }
  if (a.avg_hr) z[zoneOf(a.avg_hr, b)] = (a.moving_s || 0) / 60;
  return [z, false];
}

export function weeklyZones(ctx, weeks, today) {
  const [b, src] = zoneBounds(ctx), monday = mondayOf(today), out = [];
  let exact = 0, total = 0;
  for (let w = weeks - 1; w >= 0; w--) {
    const start = addDays(monday, -7 * w), end = addDays(start, 7);
    let z = [0, 0, 0, 0, 0];
    for (const a of loadRows(ctx, start)) {
      if (dayOf(a) >= end) continue;
      const [m, ex] = activityMinutes(ctx, a, b);
      z = z.map((x, i) => x + m[i]); total++; exact += ex ? 1 : 0;
    }
    out.push({ semaine: start, minutes: z.map(x => rnd(x)) });
  }
  return {
    bornes_haute_z1_z4: b, source_bornes: src, semaines: out,
    precision: `${exact}/${total} activités avec données détaillées`, repartition: polarization(out),
  };
}

function polarization(weeks) {
  const tot = [0, 1, 2, 3, 4].map(i => sum(weeks, w => w.minutes[i])), n = sum(tot) || 1;
  return {
    bas_z1_z2_pct: rnd((tot[0] + tot[1]) / n * 100), moyen_z3_pct: rnd(tot[2] / n * 100),
    haut_z4_z5_pct: rnd((tot[3] + tot[4]) / n * 100),
  };
}

export function report(ctx, today) {
  const wk = weekly(ctx, 8, today);
  return {
    zones_fc: weeklyZones(ctx, 6, today), forme: fitnessForm(ctx, today), acwr: acwr(ctx, today),
    semaines: wk, dernieres_activites: recentActivities(ctx),
    derniere_activite: ctx.acts.length ? ctx.acts[ctx.acts.length - 1].start_date : null,
  };
}

/* ---------- plan ---------- */
const LONG_CAP = [[12, 16], [25, 22], [50, 32]];
const PEAK_CAP = [[7, 45], [12, 55], [25, 70], [50, 90]];
const LAYOUT = { 3: '1Q 3E 6L', 4: '1Q 3E 5E 6L', 5: '1Q 2E 3S 5E 6L', 6: '0E 1Q 2E 3S 5E 6L' };
const cap = (table, x) => { for (const [lim, v] of table) if (x <= lim) return v; return table[table.length - 1][1]; };

export function setGoal(name, distanceKm, raceDate, targetTime, days, today) {
  return { name, distance_km: distanceKm, date: raceDate, target_s: parseTime(targetTime), days, plan_start: mondayOf(today) };
}

export function races(ctx) {
  const manual = new Set(ctx.meta.manual_races || []), out = [];
  for (const a of ctx.acts) {
    if (!RUN.has(a.sport) || (a.distance_m || 0) < 3000 || !a.moving_s) continue;
    if (a.workout_type === 1 || manual.has(a.id)) {
      out.push({ id: a.id, date: dayOf(a), name: a.name, dist_m: a.distance_m, time_s: a.moving_s, vdot: r1(vdot(a.distance_m, a.moving_s)) });
    }
  }
  return out;
}

function currentVdot(ctx, today, goalVdot) {
  const rs = races(ctx).filter(r => diffDays(today, r.date) <= 70);
  if (rs.length) {
    const best = rs.reduce((m, r) => (r.vdot > m.vdot ? r : m));
    return [best.vdot, `course « ${best.name} » du ${best.date}`, 'bonne'];
  }
  const c = loadRows(ctx, addDays(today, -56))
    .filter(a => RUN.has(a.sport) && (a.distance_m || 0) >= 5000 && a.moving_s).map(a => vdot(a.distance_m, a.moving_s));
  if (c.length) return [r1(Math.max(...c)), 'meilleure sortie récente (pas de course)', 'faible : sous-estime en général'];
  return [r1(goalVdot - 4), 'aucune donnée : hypothèse prudente', 'très faible'];
}

const runKm = (ctx, start, end) =>
  sum(loadRows(ctx, start).filter(a => RUN.has(a.sport) && dayOf(a) < end), a => a.distance_m || 0) / 1000;

function phaseOf(n, total, dist) {
  const taper = dist <= 25 ? 2 : 3;
  if (n < taper) return 'affûtage';
  if (n < taper + 2) return 'spécifique';
  const rest = total - taper - 2, build = rest > 6 ? rnd(rest * 0.55) : rest;
  return n < taper + 2 + build ? 'construction' : 'base';
}

const sess = (kind, d, km, extra = {}) => ({ date: d, kind, km: r1(km), ...extra });

function weekSessions(monday, phase, km, g, raceInWeek) {
  const dist = g.distance_km, days = g.days, rd = g.date;
  if (raceInWeek) {
    const s = [];
    for (const [off, kind, k] of [[-2, 'strides', 6], [-4, 'race_pace', 7], [-1, 'easy', 4]]) {
      const d = addDays(rd, off);
      if (d >= monday && d < rd) s.push(sess(kind, d, k, { km_rp: 2.0 }));
    }
    s.push(sess('race', rd, dist));
    return s.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  const slots = LAYOUT[Math.min(Math.max(days, 3), 6)].split(' ');
  const longKm = Math.min(km * (days >= 5 ? 0.28 : 0.32), cap(LONG_CAP, dist));
  const nQ = slots.filter(x => 'QS'.includes(x[1])).length, qKm = km * 0.2;
  const nEasy = slots.filter(x => x[1] === 'E').length;
  const easyKm = Math.max((km - longKm - nQ * qKm) / Math.max(nEasy, 1), 4);
  return slots.map(x => {
    const d = addDays(monday, Number(x[0])), k = x[1];
    if (k === 'L') return sess('long', d, longKm);
    if (k === 'E') return sess('easy', d, easyKm);
    if (k === 'Q') return quality(d, qKm, phase, km, g);
    return second(d, qKm, phase, km);
  });
}

function quality(d, qkm, phase, km, g) {
  if (phase === 'base') return sess('fartlek', d, qkm, { n: Math.max(5, Math.min(10, rnd(km / 6))) });
  if (phase === 'construction') return sess('tempo', d, qkm, { minutes: Math.trunc(Math.min(40, Math.max(15, km * 0.6))) });
  if (phase === 'spécifique') return sess('race_pace', d, qkm, { km_rp: r1(Math.min(g.distance_km * 0.5, Math.max(3, km * 0.22))) });
  return sess('race_pace', d, qkm * 0.7, { km_rp: 3.0 });
}
const second = (d, qkm, phase, km) =>
  phase === 'construction' || phase === 'spécifique'
    ? sess('interval', d, qkm, { n: Math.trunc(Math.min(8, Math.max(4, km / 8))) })
    : sess('strides', d, qkm * 0.6);

function buildWeeks(g, firstMonday, baseKm, startIdx, raceMonday, total) {
  const weeks = [], capKm = Math.min(cap(PEAK_CAP, g.distance_km), Math.max(baseKm * 1.5, baseKm + 15));
  let b = baseKm, peak = 0, m = firstMonday, idx = startIdx;
  while (m <= raceMonday) {
    const n = Math.trunc(diffDays(raceMonday, m) / 7), phase = phaseOf(n, total, g.distance_km);
    const recovery = idx % 4 === 3 && (phase === 'base' || phase === 'construction');
    let km, chain;
    if (phase === 'affûtage') {
      const taper = g.distance_km <= 25 ? 2 : 3;
      const f = taper === 3 ? [0.35, 0.6, 0.8][Math.min(n, 2)] : [0.45, 0.7][Math.min(n, 1)];
      km = Math.max(peak || b, b) * f; chain = b;
    } else {
      if (recovery) { km = b * 0.75; chain = b; }
      else { b = Math.min(b * (phase === 'base' ? 1.06 : 1.08), capKm); km = b; chain = b; }
      peak = Math.max(peak, b);
    }
    weeks.push({ monday: m, phase, km: r1(km), chain_km: r1(chain), recovery, sessions: weekSessions(m, phase, km, g, n === 0) });
    m = addDays(m, 7); idx++;
  }
  return weeks;
}

/** Crée ou réajuste le plan. `ctx.meta.plan` contient l'ancien plan ; retourne le nouveau. */
export function updatePlan(ctx, today, forceNew = false) {
  const g = ctx.meta.goal;
  if (!g) throw new Error('Aucun objectif défini.');
  const raceMonday = mondayOf(g.date), cur = mondayOf(today);
  if (cur > raceMonday) throw new Error('La date de course est passée : définissez un nouvel objectif.');
  const total = Math.trunc(diffDays(raceMonday, g.plan_start) / 7) + 1;
  const gv = vdot(g.distance_km * 1000, g.target_s);
  const [vd, src, conf] = currentVdot(ctx, today, gv);
  const old = forceNew ? null : ctx.meta.plan;
  const notes = [], rep = report(ctx, today);
  let weeks;

  if (old) {
    const frozen = old.weeks.filter(w => w.monday <= cur), first = addDays(cur, 7);
    const prev = old.weeks.find(w => w.monday === addDays(cur, -7));
    const chain = frozen.length ? frozen[frozen.length - 1].chain_km : old.weeks[0].chain_km;
    let base = chain;
    if (prev) {
      const actual = runKm(ctx, addDays(cur, -7), cur), ratio = prev.km ? actual / prev.km : 1;
      if (ratio < 0.6) {
        const a2 = runKm(ctx, addDays(cur, -14), cur) / 2;
        base = Math.max(a2, chain * 0.6);
        notes.push(`Semaine dernière : ${rnd(actual)} km réalisés sur ${rnd(prev.km)} prévus. Reprise progressive à ${rnd(base)} km, sans rattrapage.`);
      } else if (ratio < 0.9) {
        base = (chain + actual) / 2;
        notes.push(`Semaine dernière à ${rnd(ratio * 100)}% du prévu : progression ralentie, pas de rattrapage.`);
      }
    }
    base = Math.max(base, 12);
    weeks = first <= raceMonday ? [...frozen, ...buildWeeks(g, first, base, frozen.length, raceMonday, total)] : frozen;
    if (old.vdot && Math.abs(vd - old.vdot) >= 0.5) notes.push(`Niveau réévalué : VDOT ${fl(old.vdot)} → ${fl(vd)} (${src}). Allures mises à jour.`);
  } else {
    const base = Math.max(runKm(ctx, addDays(cur, -28), cur) / 4, 12);
    weeks = buildWeeks(g, cur, base, 0, raceMonday, total);
    notes.push(`Plan créé : base de départ ${rnd(base)} km/semaine (moyenne des 4 dernières semaines).`);
  }

  const f = rep.forme;
  if (rep.acwr && (rep.acwr > 1.5 || f.tsb < -25)) {
    const nxt = weeks.find(w => w.monday > cur && w.phase !== 'affûtage');
    if (nxt) {
      nxt.km = r1(nxt.km * 0.7);
      nxt.sessions = weekSessions(nxt.monday, nxt.phase, nxt.km, g, false);
      notes.push(`Fatigue élevée (ACWR ${fl(rep.acwr)}, fraîcheur ${fl(f.tsb)}) : semaine du ${nxt.monday} allégée de 30 %.`);
    }
  }

  const pred = predictTime(vd, g.distance_km * 1000), weeksLeft = Math.trunc(diffDays(raceMonday, cur) / 7), gap = gv - vd;
  if (gap > 0.15 * weeksLeft + 0.5) {
    notes.push(`⚠ Objectif ambitieux : il faudrait gagner ${fl(rnd(gap, 1))} points de VDOT en ${weeksLeft} semaines (~${fl(rnd(0.15 * weeksLeft, 1))} réaliste). Temps prédit aujourd'hui : ${fmtTime(pred)}.`);
  } else if (gap < -1.5) {
    notes.push(`Votre niveau actuel permet déjà ~${fmtTime(pred)} : vous pouvez viser plus ambitieux que ${fmtTime(g.target_s)}.`);
  }
  return { generated: today, vdot: vd, vdot_source: src, confiance: conf, vdot_objectif: r1(gv), temps_predit_s: rnd(pred), weeks, notes };
}

export function describe(s, paces, g) {
  const [E, T, I] = ['E', 'T', 'I'].map(k => fmtPace(paces[k]));
  const gp = fmtPace(g.target_s / g.distance_km);
  const k = s.kind;
  if (k === 'easy') return `${s.km} km facile (${E})`;
  if (k === 'long') return `${s.km} km sortie longue, allure facile (${E})`;
  if (k === 'fartlek') return `${s.km} km avec ${s.n}×1' vif (~${I}) / 1'30 trot`;
  if (k === 'tempo') return `${s.km} km dont ${s.minutes}' continues à allure seuil (${T})`;
  if (k === 'interval') return `${s.km} km dont ${s.n}×1000 m à ${I}, récup 2' trot`;
  if (k === 'strides') return `${s.km} km facile (${E}) + 6×100 m de lignes droites`;
  if (k === 'race_pace') return `${s.km} km dont ${s.km_rp} km à allure objectif (${gp})`;
  return `COURSE ${g.name} — objectif ${fmtTime(g.target_s)} (${gp})`;
}

/** Plan prêt pour l'affichage. */
export function planData(ctx, today) {
  const { goal: g, plan } = ctx.meta;
  if (!g || !plan) return { goal: g || null, plan: null };
  const paces = trainingPaces(plan.vdot), curMonday = mondayOf(today);
  const weeks = plan.weeks.map(w => ({
    monday: w.monday, phase: w.phase, km: w.km, recovery: w.recovery,
    actual: w.monday <= today ? r1(runKm(ctx, w.monday, addDays(w.monday, 7))) : null,
    current: w.monday === curMonday,
    sessions: w.sessions.map(s => {
      let status = s.kind === 'race' ? 'race' : 'upcoming';
      if (s.date < today) {
        const ok = loadRows(ctx, s.date).some(a => RUN.has(a.sport) && dayOf(a) === s.date && (a.distance_m || 0) / 1000 >= 0.6 * s.km);
        status = ok ? 'done' : 'missed';
      }
      return { date: s.date, kind: s.kind, km: s.km, text: describe(s, paces, g), status };
    }),
  }));
  return {
    goal: { ...g, target: fmtTime(g.target_s), goal_pace: fmtPace(g.target_s / g.distance_km) },
    plan: {
      vdot: plan.vdot, vdot_source: plan.vdot_source, confiance: plan.confiance, vdot_objectif: plan.vdot_objectif,
      predicted: fmtTime(plan.temps_predit_s), paces: Object.fromEntries(Object.entries(paces).map(([k, v]) => [k, fmtPace(v)])),
      notes: plan.notes, weeks,
    },
  };
}

export function summaryForCoach(ctx, today) {
  const { goal: g, plan } = ctx.meta;
  if (!g || !plan) return null;
  const paces = trainingPaces(plan.vdot), cur = mondayOf(today);
  return {
    objectif: g, vdot: plan.vdot, vdot_objectif: plan.vdot_objectif, temps_predit: fmtTime(plan.temps_predit_s),
    notes: plan.notes, courses_recentes: races(ctx).slice(-3),
    semaines_a_venir: plan.weeks.filter(w => w.monday >= cur).slice(0, 2).map(w => ({
      semaine: w.monday, phase: w.phase, km: w.km, seances: w.sessions.map(s => `${describe(s, paces, g)} (${s.date})`),
    })),
  };
}

/** Toutes les données du tableau de bord. */
export function dashboard(ctx, today) {
  return { has_data: ctx.acts.length > 0, report: report(ctx, today), series: fitnessSeries(ctx, 90, today),
    races: races(ctx).slice(-5), ...planData(ctx, today) };
}
