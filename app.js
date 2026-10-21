import * as E from './engine.js';
import * as db from './db.js';
import * as S from './strava.js';
import { buildPrompt } from './coach.js';
import { importFiles } from './importer.js';
import { pullInbox, validInboxUrl, findDuplicate } from './inbox.js';
import { STRATEGIES, racePlan, checkpoints, courseProfileFromGpx, racePlanText, fmtPaceS, fmtClock } from './racepace.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', {weekday:'short', day:'2-digit', month:'2-digit'});
const hms = s => `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const PHASE = {base:'Base', construction:'Construction', 'spécifique':'Spécifique', 'affûtage':'Affûtage'};
const APP_VERSION = 'v11';
let inboxLast = null, pulling = false, lastPullAt = 0;
let coachDraft = { reply: '', pending: null }; // réponse collée et aperçu en attente de validation
const WD_NAMES = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
let D = null, ctx = null, tokens = null, view = 'home', busy = false, codeScreen = null;

function judgeTSB(v){ return v < -25 ? ['Surcharge','bad'] : v < -10 ? ['Charge forte','warn'] : v <= 5 ? ['Zone productive','good'] : v <= 15 ? ['Frais','good'] : ['Désentraînement','warn']; }
function judgeACWR(v){ return v == null ? ['—','muted'] : v > 1.5 ? ['Risque de blessure','bad'] : v > 1.3 ? ['Attention','warn'] : v >= 0.8 ? ['Équilibré','good'] : ['Sous-charge','warn']; }

/* ---------- graphiques SVG ---------- */
function axes(W, H, pad, ymin, ymax, ticks = 4) {
  let s = '';
  for (let i = 0; i <= ticks; i++) {
    const v = ymin + (ymax - ymin) * i / ticks, y = H - pad.b - (H - pad.t - pad.b) * i / ticks;
    s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }
  return s;
}
function lineChart(series, keys) {
  const W = 640, H = 220, pad = {l:34, r:8, t:8, b:22};
  const vals = series.flatMap(p => keys.map(k => p[k.key]));
  let ymin = Math.min(0, ...vals), ymax = Math.max(10, ...vals);
  ymax = Math.ceil(ymax / 10) * 10; ymin = Math.floor(ymin / 10) * 10;
  const x = i => pad.l + (W - pad.l - pad.r) * i / (series.length - 1);
  const y = v => H - pad.b - (H - pad.t - pad.b) * (v - ymin) / (ymax - ymin);
  let s = axes(W, H, pad, ymin, ymax);
  if (ymin < 0) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-dasharray="3 3"/>`;
  for (const k of keys) {
    const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k.key]).toFixed(1)}`).join('');
    s += `<path d="${d}" fill="none" stroke="${k.color}" stroke-width="2"/>`;
  }
  [0, Math.floor(series.length / 2), series.length - 1].forEach(i => {
    s += `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}">${series[i].date.slice(5)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution de la forme">${s}</svg>`;
}
function barChart(rows) { // rows: {label, plan, actual}
  const W = 640, H = 220, pad = {l:34, r:8, t:8, b:22};
  const ymax = Math.max(10, Math.ceil(Math.max(...rows.map(r => Math.max(r.plan || 0, r.actual || 0))) / 10) * 10);
  const bw = (W - pad.l - pad.r) / rows.length, y = v => H - pad.b - (H - pad.t - pad.b) * v / ymax;
  let s = axes(W, H, pad, 0, ymax);
  rows.forEach((r, i) => {
    const x0 = pad.l + i * bw, w = Math.max(bw * 0.36, 2);
    s += `<rect x="${x0 + bw * 0.1}" width="${w}" y="${y(r.plan)}" height="${H - pad.b - y(r.plan)}" fill="var(--line)" stroke="var(--muted)" stroke-width=".5"><title>${esc(r.label)} — prévu ${r.plan} km</title></rect>`;
    if (r.actual != null) s += `<rect x="${x0 + bw * 0.1 + w + 1}" width="${w}" y="${y(r.actual)}" height="${H - pad.b - y(r.actual)}" fill="var(--accent)"><title>${esc(r.label)} — fait ${r.actual} km</title></rect>`;
    if (rows.length <= 26 ? i % 2 === 0 : i % 4 === 0) s += `<text x="${x0 + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(r.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Volume prévu et réalisé">${s}</svg>`;
}
function zonesChart(weeks) {
  const W = 640, H = 200, pad = {l:34, r:8, t:8, b:22};
  const tot = weeks.map(w => w.minutes.reduce((a, b) => a + b, 0));
  const ymax = Math.max(60, Math.ceil(Math.max(...tot) / 60) * 60), bw = (W - pad.l - pad.r) / weeks.length;
  const y = v => H - pad.b - (H - pad.t - pad.b) * v / ymax;
  let s = axes(W, H, pad, 0, ymax);
  weeks.forEach((w, i) => {
    let acc = 0;
    w.minutes.forEach((m, z) => {
      if (!m) return;
      s += `<rect x="${pad.l + i * bw + bw * 0.15}" width="${bw * 0.7}" y="${y(acc + m)}" height="${H - pad.b - y(m)}" fill="var(--z${z + 1})"><title>Z${z + 1} : ${m} min</title></rect>`;
      acc += m;
    });
    s += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${w.semaine.slice(5)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Temps par zone de fréquence cardiaque">${s}</svg>`;
}
const legend = items => `<div class="legend">${items.map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('')}</div>`;


/* ---------- sections ---------- */
function kpis() {
  const r = D.report, f = r.forme, [tl, tc] = judgeTSB(f.tsb), [al, ac] = judgeACWR(r.acwr);
  return `<div class="grid" style="margin-bottom:16px">
    <div class="card kpi" style="margin:0"><div class="l">Forme (CTL)</div><div class="v">${f.ctl}</div><div class="s muted">42 derniers jours</div></div>
    <div class="card kpi" style="margin:0"><div class="l">Fatigue (ATL)</div><div class="v">${f.atl}</div><div class="s muted">7 derniers jours</div></div>
    <div class="card kpi" style="margin:0"><div class="l">Fraîcheur (TSB)</div><div class="v">${f.tsb}</div><div class="s ${tc}">${tl}</div></div>
    <div class="card kpi" style="margin:0"><div class="l">Charge 7j / 28j</div><div class="v">${r.acwr ?? '—'}</div><div class="s ${ac}">${al}</div></div>
    ${D.plan ? `<div class="card kpi" style="margin:0"><div class="l">${esc(D.goal.distance_km)} km aujourd'hui</div><div class="v">${esc(D.plan.predicted)}</div><div class="s muted">objectif ${esc(D.goal.target)}${D.plan.confiance === 'bonne' ? '' : D.plan.confiance === 'moyenne' ? ' · estimation' : ' · estimation peu fiable'}</div></div>` : ''}
  </div>`;
}
function goalForm(existing) {
  const g = existing || {};
  const wd = g.weekdays?.length ? g.weekdays : E.DEFAULT_WEEKDAYS[Math.min(Math.max(g.days || 4, 3), 6)];
  const ld = g.long_day ?? (wd.includes(6) ? 6 : wd[wd.length - 1]);
  return `<form id="goalForm">
    <div><label>Nom de la course</label><input name="name" required value="${esc(g.name || '')}" placeholder="Semi de Lyon"></div>
    <div><label>Distance (km)</label><input name="distance" type="number" step="0.1" min="1" required value="${esc(g.distance_km || 21.1)}"></div>
    <div><label>Date</label><input name="date" type="date" required value="${esc(g.date || '')}"></div>
    <div><label>Temps visé (h:mm:ss)</label><input name="time" required pattern="\\d{1,2}(:\\d{2}){1,2}" value="${esc(g.target_s ? hms(g.target_s) : '')}" placeholder="1:45:00"></div>
    <div style="grid-column:1/-1"><label>Jours où vous pouvez courir (3 à 6)</label>
      <div class="chips">${WD_NAMES.map((n, i) => `<label class="chip"><input type="checkbox" name="wd" value="${i}" ${wd.includes(i) ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div></div>
    <div><label>Jour de la sortie longue</label><select name="long_day">${WD_NAMES.map((n, i) => `<option value="${i}" ${i === ld ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div><button class="primary" type="submit">${existing ? 'Mettre à jour l\'objectif' : 'Créer mon plan'}</button></div>
  </form><div id="goalErr" class="err"></div>`;
}
/** Petit graphique : une barre par km, plus haute = plus rapide. */
function paceBars(rows) {
  const full = rows.filter(r => r.d > 0.999), lo = Math.min(...full.map(r => r.pace)), hi = Math.max(...full.map(r => r.pace)), W = 320, H = 70, bw = W / full.length;
  const bars = full.map((r, i) => { const h = hi === lo ? 40 : 14 + (hi - r.pace) / (hi - lo) * 44; return `<rect x="${i * bw + 1}" y="${H - h}" width="${Math.max(bw - 2, 1)}" height="${h}" rx="2" fill="var(--accent)" opacity="${r.grade != null && r.grade > 0.02 ? 0.55 : 1}"><title>${esc(r.label)} : ${fmtPaceS(r.pace)}/km</title></rect>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Allure à viser par kilomètre" style="max-height:80px">${bars}</svg>`;
}
function raceSection(g) {
  const course = ctx.meta.course || {}, strat = STRATEGIES[course.strategy] ? course.strategy : 'progressive', prof = course.profile || null;
  const plan = racePlan(g, strat, prof), cps = checkpoints(plan, g.distance_km), cpSet = new Set(cps.map(c => Math.round(c[0] * 1000)));
  const isCp = r => cpSet.has(Math.round(r.to * 1000)) && (r.to % 5 === 0 || r.to === g.distance_km);
  return `<details class="card" style="margin:12px 0"><summary><b>🏁 Plan de course</b> <span class="muted">— allure à viser par km</span></summary>
    <p class="muted" style="margin:10px 0 6px">Pour tenir ${esc(fmtClock(g.target_s))} sur ${esc(g.distance_km)} km : moyenne <b>${fmtPaceS(plan.avg_pace)}/km</b>, départ <b>${fmtPaceS(plan.first)}</b>, fin <b>${fmtPaceS(plan.last)}</b>.</p>
    <label>Stratégie</label>
    <select id="raceStrategy">${Object.entries(STRATEGIES).map(([k, v]) => `<option value="${k}" ${k === strat ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
    <p class="muted" style="font-size:13px">Les premiers kilomètres trop rapides coûtent cher en fin de course : le départ prudent est la règle la plus sûre.</p>
    <label style="margin-top:8px">Profil du parcours <span class="muted">(GPX de la course, facultatif : ajuste l'allure aux côtes)</span></label>
    ${prof ? `<p style="margin:4px 0">✓ <b>${esc(prof.name)}</b> — ${prof.length_km} km, D+ ${prof.gain_m} m, D− ${prof.loss_m} m <button class="mini" id="courseClear" style="opacity:1">Retirer</button></p>` : '<input id="courseGpx" type="file" accept=".gpx,application/gpx+xml,text/xml">'}
    ${plan.warning ? `<p class="warn" style="font-size:13px">${esc(plan.warning)}</p>` : ''}
    <div style="margin:10px 0">${paceBars(plan.rows)}</div>
    <div class="scroll"><table class="racetab"><tr><th>Km</th><th class="n">Allure</th><th class="n">Cumulé</th>${prof ? '<th class="n">Pente</th>' : ''}</tr>
      ${plan.rows.map(r => `<tr style="${isCp(r) ? 'font-weight:650;background:var(--bg)' : ''}"><td>${esc(r.label.replace('Km ', ''))}</td><td class="n">${fmtPaceS(r.pace)}</td><td class="n">${fmtClock(r.cum)}</td>${prof ? `<td class="n muted">${(r.grade * 100).toFixed(1)} %</td>` : ''}</tr>`).join('')}</table></div>
    <p class="muted" style="font-size:13px;margin:8px 0">Passages : ${cps.map(([k, t]) => `${Math.abs(k - 21.0975) < 1e-6 ? 'semi' : k} km ${fmtClock(t)}`).join(' · ')}</p>
    <div class="row"><button id="raceCopy" class="primary">Copier le plan</button>${navigator.share ? '<button id="raceShare">Partager</button>' : ''}</div>
  </details>`;
}
function coachBanner(p) {
  if (!p.coach) return '';
  return `<div class="card banner" style="margin:10px 0"><b>🧠 Séances proposées par le coach</b> <span class="muted">(du ${fmtDate(p.coach.from)} au ${fmtDate(p.coach.to)}, appliquées le ${fmtDate(p.coach.applied)})</span>
    ${p.coach.notes.length ? `<ul class="notes">${p.coach.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <button id="coachRevert" class="mini" style="opacity:1">Revenir au plan automatique</button></div>`;
}
function pauseBlock(p) {
  if (p.pause && !p.pause.to) {
    return `<div class="card banner" style="margin:10px 0"><b>⏸ En pause depuis le ${fmtDate(p.pause.from)}</b>
      <p class="muted" style="margin:6px 0">Aucune séance n'est prévue. À la reprise, le volume repart plus bas selon la durée de l'arrêt, sans rattrapage.</p>
      <button class="primary" id="resumeBtn">Reprendre l'entraînement</button></div>`;
  }
  return `<details style="border:0;padding:4px 0"><summary class="muted">⏸ Blessure ou maladie : mettre en pause</summary>
    <p class="muted">Les séances à venir sont retirées. À la reprise, le volume repart plus bas (selon la durée de l'arrêt), sans rattrapage. En cas de douleur persistante, consultez un professionnel de santé.</p>
    <button id="pauseBtn">Mettre en pause à partir d'aujourd'hui</button></details>`;
}
function levelCard(p) {
  return `<details class="card"><summary><b>🏁 Affiner mon niveau</b> <span class="tag">confiance : ${esc(String(p.confiance).split(' ')[0])}</span></summary>
    <p class="muted">Pour des allures fiables, ajoutez une course ou un test à fond (5 km, 10 km…) fait ces 10 dernières semaines. Vous pouvez aussi marquer une activité avec 🏁 dans « Dernières activités ». Si la course est déjà dans vos activités, marquez-la plutôt que de la ressaisir.</p>
    <form id="quickRace">
      <div><label>Date</label><input name="date" type="date" required value="${today()}" max="${today()}"></div>
      <div><label>Distance</label><select name="km"><option value="5">5 km</option><option value="10">10 km</option><option value="15">15 km</option><option value="21.1" selected>Semi (21,1 km)</option><option value="42.2">Marathon</option></select></div>
      <div><label>Temps (h:mm:ss)</label><input name="time" required placeholder="45:00" pattern="\\d{1,2}(:\\d{2}){1,2}"></div>
      <div><button class="primary" type="submit">Ajouter ma course</button></div>
    </form><div id="quickErr" class="err"></div></details>`;
}
function planSection() {
  if (!D.goal || !D.plan) {
    return `<div class="card"><h2>Mon objectif</h2><p class="muted">Définissez la course visée : le plan se construit à partir de votre niveau actuel et se réajuste à chaque synchronisation.</p>${goalForm(null)}</div>`;
  }
  const p = D.plan, g = D.goal;
  const weeks = p.weeks, ci = Math.max(weeks.findIndex(w => w.current), 0);
  const shown = weeks.slice(ci);
  const icon = s => ({ done: `<span class="good" title="${s.done_on ? 'Fait le ' + fmtDate(s.done_on) : 'Fait'}">✓</span>`,
    missed: '<span class="bad" title="Manqué">✗</span>', pending: '<span class="warn" title="Pas encore fait cette semaine">⏳</span>', race: '🏁',
    upcoming: s.kind === 'race' ? '🏁' : `<button class="mini" data-move="${esc(s.key)}" aria-label="Déplacer" title="Déplacer cette séance">⇄</button>` })[s.status];
  const tag = s => s.coach ? ' <span class="tag" title="Séance proposée par le coach">🧠</span>' : '';
  const note = s => s.done_on ? ` <span class="muted">(faite le ${fmtDate(s.done_on)})</span>` : s.moved ? ' <span class="muted">(déplacée)</span>' : '';
  const wk = (w, open) => `<details ${open ? 'open' : ''}><summary>
      <span><b>${fmtDate(w.monday)}</b> <span class="tag ${w.current ? 'cur' : ''}">${PHASE[w.phase] || w.phase}${w.recovery ? ' · récup' : ''}</span></span>
      <span class="muted">prévu ${Math.round(w.km)} km${w.actual != null ? ` · fait ${Math.round(w.actual)} km` : ''}</span></summary>
      ${w.paused ? '<p class="muted">⏸ Pause : aucune séance prévue.</p>' : ''}
      ${w.sessions.map(s => `<div class="sess" data-week="${w.monday}"><span class="d">${fmtDate(s.date)}</span><span>${esc(s.text)}${tag(s)}${note(s)}</span><span class="st">${icon(s)}</span></div>`).join('')}
    </details>`;
  return `<div class="card">
    <h2>🎯 ${esc(g.name)} — ${esc(g.distance_km)} km le ${new Date(g.date + 'T12:00').toLocaleDateString('fr-FR', {day:'numeric', month:'long', year:'numeric'})} en ${esc(g.target)} (${esc(g.goal_pace)})</h2>
    <p class="muted" style="margin-top:-6px">Niveau VDOT ${p.vdot} (${esc(p.vdot_source)} — confiance ${esc(p.confiance)}) · objectif VDOT ${p.vdot_objectif}<br>
    Allures : ${Object.entries(p.paces).map(([k, v]) => `<b>${k}</b> ${v}`).join(' · ')}</p>
    ${p.notes.length ? `<ul class="notes">${p.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${coachBanner(p)}
    ${pauseBlock(p)}
    ${shown.slice(0, 3).map((w, i) => wk(w, i < 2)).join('')}
    <details><summary class="muted">Voir toutes les semaines (${shown.length - 3 > 0 ? shown.length - 3 : 0} de plus)</summary>
      ${shown.slice(3).map(w => wk(w, false)).join('')}</details>
    ${raceSection(g)}
    <details><summary class="muted">Modifier l'objectif / signaler une course</summary><div style="padding-top:10px">
      ${goalForm({...g, days: g.days})}
      <p class="muted">Course non étiquetée « Course » sur Strava ? Entrez l'ID de l'activité (dans son URL) :</p>
      <form id="raceForm" style="grid-template-columns:1fr auto"><input name="id" type="number" placeholder="ID activité" required><button>Marquer comme course</button></form>
    </div></details>
  </div>
  ${p.confiance !== 'bonne' ? levelCard(p) : ''}
  <div class="card"><h2>Volume hebdomadaire : prévu vs réalisé (km)</h2>
    ${barChart(weeks.map(w => ({label: w.monday.slice(5), plan: w.km, actual: w.actual})))}
    ${legend([['var(--line)', 'Prévu'], ['var(--accent)', 'Réalisé']])}</div>`;
}
function chartsSection() {
  const z = D.report.zones_fc, rp = z.repartition;
  return `<div class="card"><h2>Forme et fatigue (90 jours)</h2>
      ${D.series.length > 1 ? lineChart(D.series, [{key:'ctl', color:'var(--blue)'}, {key:'atl', color:'var(--accent)'}, {key:'tsb', color:'var(--good)'}]) : ''}
      ${legend([['var(--blue)', 'Forme (CTL)'], ['var(--accent)', 'Fatigue (ATL)'], ['var(--good)', 'Fraîcheur (TSB)']])}</div>
    <div class="card"><h2>Zones de fréquence cardiaque (minutes / semaine)</h2>
      ${zonesChart(z.semaines)}
      ${legend([['var(--z1)', 'Z1 récup'], ['var(--z2)', 'Z2 endurance'], ['var(--z3)', 'Z3 tempo'], ['var(--z4)', 'Z4 seuil'], ['var(--z5)', 'Z5 VO2max']])}
      <p>Répartition : <b>${rp.bas_z1_z2_pct}%</b> facile · <b class="${rp.moyen_z3_pct > 25 ? 'warn' : ''}">${rp.moyen_z3_pct}%</b> tempo · <b>${rp.haut_z4_z5_pct}%</b> dur
      ${rp.moyen_z3_pct > 25 ? '<br><span class="warn">Beaucoup de Z3 : zone grise, trop dur pour récupérer, pas assez pour progresser.</span>' : ''}</p>
      <p class="muted" style="font-size:13px">Bornes (${esc(z.source_bornes)}) : Z1 &lt; ${z.bornes_haute_z1_z4[0]} · Z2 &lt; ${z.bornes_haute_z1_z4[1]} · Z3 &lt; ${z.bornes_haute_z1_z4[2]} · Z4 &lt; ${z.bornes_haute_z1_z4[3]} bpm — précision : ${esc(z.precision)}</p></div>`;
}
const isManual = id => ctx.acts.find(a => a.id === id)?.source === 'manual';
const raceIds = () => new Set(E.races(ctx).map(r => r.id));
function activitiesSection() {
  const rows = D.report.dernieres_activites;
  return `<div class="card"><h2>Dernières activités</h2><div class="scroll"><table>
    <tr><th>Date</th><th>Sport</th><th class="n">km</th><th class="n">min</th><th class="n">Allure</th><th class="n">FC moy</th><th class="n">D+</th><th title="Marquer comme course">🏁</th></tr>
    ${rows.map(a => `<tr><td>${fmtDate(a.date)}</td><td>${esc(a.sport)}</td><td class="n">${a.km}</td><td class="n">${a.duree_min}</td>
      <td class="n">${esc(a.allure || '—')}</td><td class="n">${a.fc_moy ? Math.round(a.fc_moy) : '—'}</td><td class="n">${a.d_plus != null ? Math.round(a.d_plus) : '—'}</td>
      <td><button class="mini ${raceIds().has(a.id) ? 'on' : ''}" data-race="${a.id}" aria-label="Course" title="Marquer comme course">🏁</button>${isManual(a.id) ? ` <button class="mini" data-del="${a.id}" aria-label="Supprimer" title="Supprimer cette séance">✕</button>` : ''}</td></tr>`).join('')}
  </table></div></div>`;
}
function manualSection() {
  return `<details class="card"><summary><b>➕ Ajouter une séance</b> <span class="muted">sans passer par l'export</span></summary>
    <form id="manualForm" style="margin-top:12px">
      <div><label>Date</label><input name="date" type="date" required value="${today()}" max="${today()}"></div>
      <div><label>Sport</label><select name="sport"><option value="Run">Course à pied</option><option value="TrailRun">Trail</option><option value="Ride">Vélo</option><option value="Walk">Marche</option><option value="Hike">Randonnée</option><option value="Workout">Autre</option></select></div>
      <div><label>Distance (km)</label><input name="km" type="number" step="0.01" min="0" inputmode="decimal" required></div>
      <div><label>Durée (min)</label><input name="min" type="number" step="1" min="1" inputmode="numeric" required></div>
      <div><label>FC moyenne (facultatif)</label><input name="hr" type="number" min="40" max="230" inputmode="numeric"></div>
      <div><label>Dénivelé + (m, facultatif)</label><input name="elev" type="number" min="0" inputmode="numeric"></div>
      <div><label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="race" style="width:auto"> C'était une course</label></div>
      <div><button class="primary" type="submit">Ajouter</button></div>
    </form><div id="manualErr" class="err"></div></details>`;
}
function coachSection() {
  const mem = ctx.meta.coach_memory || [], hasGoal = !!ctx.meta.goal && !!ctx.meta.plan;
  return `<div class="card"><h2>🧠 Mon coach</h2>
    <p class="muted">① Générez le message et collez-le dans une IA (Claude, ChatGPT…). ② Collez ici sa réponse : l'app lit ses séances, vous les montre, et les applique à votre plan si vous validez.</p>
    <label>Mon état du jour, mes contraintes <span class="muted">(facultatif)</span></label>
    <textarea id="coachState" style="min-height:60px" placeholder="ex. mollet gauche tendu, voyage jeudi, peu de sommeil…">${esc(ctx.meta.coach_state || '')}</textarea>
    <button id="coachBtn" style="margin-top:8px">① Générer le message pour le coach</button>
    <div id="coachOut" style="display:none;margin-top:12px"><textarea id="coachTxt" readonly></textarea>
      <button id="copyBtn" class="primary" style="margin-top:8px">Copier</button></div>
    <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
    <label>② Réponse de l'IA <span class="muted">(collez-la en entier, y compris le bloc de code à la fin)</span></label>
    ${hasGoal ? '' : '<p class="muted">Créez d\'abord un objectif : le coach propose des séances pour votre plan.</p>'}
    <textarea id="coachReply" style="min-height:90px" placeholder="Collez ici la réponse complète de l'IA…" ${hasGoal ? '' : 'disabled'}>${esc(coachDraft.reply)}</textarea>
    <button id="coachRead" style="margin-top:8px" ${hasGoal ? '' : 'disabled'}>Lire la réponse</button>
    <div id="coachErr" class="err"></div>
    <div id="coachPreview">${coachDraft.pending ? coachPreview(coachDraft.pending) : ''}</div>
    ${mem.length ? `<details style="margin-top:12px"><summary class="muted">Mémoire du coach (${mem.length} remarque${mem.length > 1 ? 's' : ''}, renvoyées dans les messages suivants)</summary>
      <ul class="notes">${mem.map(m => `<li><span class="muted">${esc(m.date)}</span> ${esc(m.text)}</li>`).join('')}</ul>
      <button id="clearMem" class="mini" style="opacity:1">Effacer la mémoire</button></details>` : ''}</div>`;
}
function coachPreview(res) {
  const paces = E.trainingPaces(ctx.meta.plan.vdot), g = ctx.meta.goal;
  const current = d => ctx.meta.plan.weeks.flatMap(w => w.sessions).filter(x => x.date === d).map(x => E.describe(x, paces, g)).join(' ; ') || '— repos —';
  return `<div class="card" style="margin:12px 0 0;border-color:var(--accent)"><h2 style="margin-bottom:6px">Proposition du coach</h2>
    <p class="muted" style="margin:0 0 8px">Du ${fmtDate(res.window.from)} au ${fmtDate(res.window.to)} : ces séances remplacent celles du plan sur ces jours.</p>
    ${res.valid.map(v => `<div class="sess"><span class="d">${fmtDate(v.date)}</span><span>${esc(E.describe(v, paces, g))}<br><span class="muted">Plan actuel : ${esc(current(v.date))}</span></span><span></span></div>`).join('')}
    ${res.rejected.length ? `<p class="warn" style="margin:10px 0 2px"><b>Refusées par l'app</b> (non appliquées) :</p><ul class="notes">${res.rejected.map(r => `<li>${esc(r.label)} — ${esc(r.reason)}</li>`).join('')}</ul>` : ''}
    ${res.warnings.length ? `<ul class="notes warn">${res.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${res.notes.length ? `<p style="margin:10px 0 2px"><b>Remarques du coach</b> (gardées en mémoire) :</p><ul class="notes">${res.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <div class="row" style="margin:12px 0 0"><button class="primary" id="coachApply">Appliquer ces séances</button><button id="coachCancel">Annuler</button></div></div>`;
}


/* ---------- état, actions ---------- */
const setStatus = (msg, err = false) => { $('#status').innerHTML = msg ? `<span class="${err ? 'err' : ''}">${esc(msg)}</span>` : ''; };
const today = () => E.todayStr();
const configured = () => !!(ctx.settings.clientId && (ctx.settings.clientSecret || ctx.settings.relayUrl));

async function refresh() {
  ctx = await db.loadContext();
  tokens = await db.getMeta('tokens');
  D = E.dashboard(ctx, today());
  render();
}

async function saveGoal(f) {
  const fd = new FormData(f), b = Object.fromEntries(fd), wd = fd.getAll('wd').map(Number);
  if (wd.length < 3 || wd.length > 6) throw new Error('Choisissez entre 3 et 6 jours de course par semaine.');
  if (!wd.includes(Number(b.long_day))) throw new Error('Le jour de la sortie longue doit faire partie des jours choisis.');
  const g = E.setGoal(b.name, Number(b.distance), b.date, b.time, wd.length, today(), { weekdays: wd, long_day: Number(b.long_day) });
  ctx.meta.goal = g; ctx.meta.plan = null; ctx.meta.moves = []; ctx.meta.pause = null; ctx.meta.coach = null;
  await db.setMeta('goal', g); await db.setMeta('moves', []); await db.delMeta('pause'); await db.delMeta('coach');
  await db.setMeta('plan', E.updatePlan(ctx, today(), true));
}

/** Ajoute une activité saisie à la main et recalcule le plan. */
async function addRun({ date, sport = 'Run', km, sec, hr = null, elev = null, race = false, name }) {
  await db.put('activities', {
    id: Date.now() + Math.floor(Math.random() * 1000), name, sport, start_date: `${date}T12:00:00Z`, distance_m: Math.round(km * 1000), moving_s: Math.round(sec),
    elevation_m: elev, avg_hr: hr, avg_speed: km * 1000 / sec, perceived_exertion: null, workout_type: race ? 1 : null, source: 'manual',
  });
  ctx = await db.loadContext();
  if (ctx.meta.goal) { try { await db.setMeta('plan', E.updatePlan(ctx, today())); } catch (err) { /* ignore */ } }
}

async function movePlanSession(key, to) {
  try {
    const moves = E.planMove(ctx, key, to, today());
    await db.setMeta('moves', moves); ctx.meta.moves = moves;
    E.applyMoves(ctx.meta.plan.weeks, moves); await db.setMeta('plan', ctx.meta.plan);
  } catch (e) { setStatus(e.message, true); await refresh(); return; }
  await refresh(); setStatus('Séance déplacée ✓');
}

/** Récupère les séances déposées dans la boîte de réception. `manual` : afficher aussi les erreurs et le « rien de nouveau ». */
async function pullFromInbox(manual) {
  const st = ctx?.settings || {};
  if (!st.inboxUrl || !st.inboxToken) { if (manual) setStatus("Renseignez l'adresse et le code de la boîte.", true); return; }
  if (pulling) return; pulling = true; lastPullAt = Date.now();
  try {
    const have = await db.getAll('activities');
    const r = await pullInbox({ url: st.inboxUrl, token: st.inboxToken }, have, async (acts, streams) => { await db.putMany('activities', acts); if (streams.length) await db.putMany('streams', streams); });
    inboxLast = { at: new Date().toISOString(), imported: r.imported, error: null }; await db.setMeta('inbox_last', inboxLast);
    if (r.imported) {
      ctx = await db.loadContext();
      if (ctx.meta.goal) { try { await db.setMeta('plan', E.updatePlan(ctx, today())); } catch (e) { /* ignore */ } }
      await refresh(); setStatus(`${r.imported} séance${r.imported > 1 ? 's' : ''} reçue${r.imported > 1 ? 's' : ''} depuis Santé ✓`);
    } else if (manual) { await refresh(); setStatus('Rien de nouveau dans la boîte.'); }
  } catch (e) {
    inboxLast = { at: new Date().toISOString(), imported: 0, error: e.message }; await db.setMeta('inbox_last', inboxLast);
    if (manual) { await refresh(); setStatus(e.message, true); }
  } finally { pulling = false; }
}

async function doSync(withStreams) {
  if (busy) return;
  busy = true; render();
  try {
    const s = ctx.settings;
    setStatus('Synchronisation en cours…');
    await S.syncActivities(s, setStatus);
    await S.syncZones(s);
    if (withStreams) await S.syncStreams(s, 30, setStatus);
    ctx = await db.loadContext();
    if (ctx.meta.goal) await db.setMeta('plan', E.updatePlan(ctx, today()));
    setStatus('Synchronisation terminée ✓');
  } catch (e) { setStatus(e.message, true); }
  busy = false; await refresh();
}

/* ---------- vues ---------- */
function homeView() {
  if (!D.has_data) {
    return `<div class="card banner"><h2>Pour commencer</h2>
      <p>Importez l'export de vos données Strava : c'est gratuit et tout reste sur ce téléphone.</p>
      <button class="primary" data-go="settings">Importer mon export</button></div>` + planSection() + manualSection();
  }
  return kpis() + planSection() + chartsSection() + activitiesSection() + manualSection() + coachSection();
}

/** Plus haute FC « crédible » vue dans vos fichiers : 99e centile par activité (évite les pics du capteur), puis le maximum. */
function observedMaxHr() {
  let best = 0;
  for (const st of Object.values(ctx.streams)) {
    const hr = (st.heartrate || []).filter(x => x > 0 && x < 230).sort((a, b) => a - b);
    if (hr.length >= 300) best = Math.max(best, hr[Math.floor((hr.length - 1) * 0.99)]);
  }
  return best || null;
}
function hrHelp(s) {
  const obs = observedMaxHr(), cur = Number(s.fcMax) || 190;
  return `<div class="muted" id="hrHelp" style="font-size:13px;margin-top:10px">
    ${obs ? `Plus haute FC relevée dans vos fichiers : <b>${obs} bpm</b>${!s.fcMax || obs > cur ? ` <button type="button" class="mini" id="useObsHr" data-hr="${obs}" style="opacity:1">Utiliser comme FC max</button>` : ''}<br>` : ''}
    <b>FC max</b> : la plus haute FC atteinte lors d'un effort à fond (fin de course ou de côte). À défaut, 220 − votre âge donne un ordre de grandeur, souvent à ±10 bpm.<br>
    <b>FC repos</b> : votre FC au réveil, allongé, avant de vous lever (moyenne de quelques matins).</div>`;
}
function settingsView() {
  const s = ctx.settings, host = location.host;
  return `<div class="card"><h2>1. Importer mon export Strava <span class="tag">gratuit</span></h2>
    <ol class="steps muted"><li>Sur strava.com : Paramètres › Mon compte › « Télécharger ou supprimer votre compte » › demandez l'archive.</li>
      <li>Téléchargez le ZIP reçu par e-mail (dans Fichiers).</li>
      <li>Touchez ci-dessous et choisissez le ZIP (ou des fichiers FIT / GPX / TCX).</li></ol>
    <input id="importFile" type="file" multiple>
    <p class="muted" style="font-size:13px">Les fichiers FIT contiennent la fréquence cardiaque (zones précises). Les GPX n'en ont pas : seuls la distance, la durée et le dénivelé sont utilisés. Un nouvel import n'ajoute que les nouveautés.</p></div>
  <div class="card"><h2>2. ❤️ Fréquence cardiaque</h2>
    <p class="muted">Elle sert à estimer votre niveau, vos zones et votre fatigue. Des valeurs justes améliorent nettement le plan.</p>
    <form id="hrForm">
      <div><label>FC max (bpm)</label><input name="fcMax" type="number" inputmode="numeric" min="120" max="230" value="${esc(s.fcMax || '')}" placeholder="190"></div>
      <div><label>FC repos (bpm)</label><input name="fcRepos" type="number" inputmode="numeric" min="30" max="100" value="${esc(s.fcRepos || '')}" placeholder="55"></div>
      <div style="grid-column:1/-1"><label>Zones FC manuelles <span class="muted">(facultatif : limites hautes Z1 à Z4, ex. 114,133,152,171)</span></label><input name="fcZones" value="${esc(s.fcZones || '')}"></div>
      <div><button class="primary" type="submit">Enregistrer</button></div>
    </form><div id="hrErr" class="err"></div>
    ${hrHelp(s)}</div>
  <div class="card"><h2>3. ⚡ Synchro automatique <span class="tag">gratuit</span></h2>
    <p class="muted">Un raccourci iPhone dépose vos séances Santé dans <b>votre</b> boîte de réception (Cloudflare, gratuit) ; l'app les récupère toute seule à l'ouverture et met le plan à jour. Mise en place : voir le README (section « Synchro automatique »). Tant que l'adresse et le code ne sont pas renseignés, rien n'est envoyé ni reçu.</p>
    <form id="inboxForm">
      <div style="grid-column:1/-1"><label>Adresse de la boîte <span class="muted">(https://….workers.dev)</span></label><input name="inboxUrl" inputmode="url" autocomplete="off" value="${esc(s.inboxUrl || '')}" placeholder="https://ma-boite.mon-compte.workers.dev"></div>
      <div style="grid-column:1/-1"><label>Code secret <span class="muted">(reste sur ce téléphone)</span></label><input name="inboxToken" type="password" autocomplete="off" value="${esc(s.inboxToken || '')}"></div>
      <div><button class="primary" type="submit">Enregistrer</button></div>
      <div><button type="button" id="pullNow">Récupérer maintenant</button></div>
    </form><div id="inboxMsg" class="muted" style="margin-top:8px">${inboxLast ? (inboxLast.error ? `<span class="err">Dernière tentative (${esc(new Date(inboxLast.at).toLocaleString('fr-FR'))}) : ${esc(inboxLast.error)}</span>` : `Dernière récupération : ${esc(new Date(inboxLast.at).toLocaleString('fr-FR'))} (${inboxLast.imported} nouvelle${inboxLast.imported > 1 ? 's' : ''} séance${inboxLast.imported > 1 ? 's' : ''}).`) : ''}</div></div>
  <details class="card"><summary><b>4. Connexion directe à Strava</b> <span class="tag">abonnement Strava requis</span></summary>
    <p class="muted">Strava réserve désormais son API aux abonnés. Inutile si vous importez votre export.</p>
    <h2 style="margin-top:12px">Application Strava</h2>
    <ol class="steps muted"><li>Sur <b>strava.com/settings/api</b>, créez une application (gratuit).</li>
    <li>« Authorization Callback Domain » : <code>${esc(location.hostname)}</code></li>
    <li>Copiez le Client ID (et le Client Secret si vous n'utilisez pas de relais).</li></ol>
    <form id="settingsForm">
      <div><label>Client ID</label><input name="clientId" inputmode="numeric" value="${esc(s.clientId || '')}"></div>
      <div><label>Client Secret <span class="muted">(reste sur ce téléphone)</span></label><input name="clientSecret" type="password" autocomplete="off" value="${esc(s.clientSecret || '')}"></div>
      <div><label>Adresse du relais <span class="muted">(optionnel, voir README)</span></label><input name="relayUrl" inputmode="url" placeholder="https://….workers.dev" value="${esc(s.relayUrl || '')}"></div>
      <div><button class="primary" type="submit">Enregistrer</button></div>
    </form></div>
  <div style="margin-top:14px"><h2>Connexion ${tokens ? '<span class="ok">✓ connecté</span>' : ''}</h2>
    <div class="row"><button id="connectBtn" ${configured() ? '' : 'disabled'}>Se connecter à Strava</button><button id="testBtn">Tester la connexion directe</button></div>
    <p class="muted" style="font-size:13px">Si, après l'autorisation, la page s'ouvre dans Safari au lieu de l'app, copiez le code affiché puis collez-le ici :</p>
    <form id="codeForm" style="grid-template-columns:1fr auto"><input name="code" placeholder="Code ou adresse complète" autocomplete="off"><button>Valider</button></form>
    <div id="testOut" class="muted" style="margin-top:8px"></div></div></details>
  <div class="card"><h2>5. Données</h2>
    <p class="muted">Tout est stocké uniquement sur cet appareil. Faites une sauvegarde de temps en temps.</p>
    <div class="row"><button id="exportBtn">Exporter une sauvegarde</button>
      <label style="margin:0"><span class="muted">Restaurer une sauvegarde</span><input id="restoreFile" type="file" accept="application/json"></label></div>
    <button id="wipeBtn" style="color:var(--bad)">Effacer toutes les données</button></div>
  <p class="muted" id="appVersion" style="text-align:center;font-size:12px"></p>`;
}

function codeView() {
  return `<div class="card banner"><h2>Autorisation reçue ✓</h2>
    <p>Cette page s'est ouverte hors de l'app installée, donc elle n'a pas accès à vos réglages.<br>
    Copiez ce code, puis ouvrez l'app depuis l'écran d'accueil : <b>Réglages › Coller le code</b>.</p>
    <textarea id="codeBox" readonly style="min-height:60px">${esc(codeScreen)}</textarea>
    <button class="primary" id="copyCode" style="margin-top:8px">Copier le code</button></div>`;
}

function render() {
  $('#tabHome').classList.toggle('on', view === 'home'); $('#tabSettings').classList.toggle('on', view === 'settings');
  $('#headActions').innerHTML = view === 'home' && configured() && tokens ? `
    <label style="display:flex;gap:6px;align-items:center;color:var(--text)"><input type="checkbox" id="streams" style="width:auto"> détails FC</label>
    <button class="primary" id="syncBtn" ${busy ? 'disabled' : ''}>Synchroniser</button>` : '';
  $('#app').innerHTML = codeScreen ? codeView() : view === 'settings' ? settingsView() : homeView();
  bind();
}

function bind() {
  const keep = [...document.querySelectorAll('#app details')];
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { view = b.dataset.go; render(); });
  const sb = $('#syncBtn'); if (sb) sb.onclick = () => doSync($('#streams').checked);

  document.querySelectorAll('#goalForm').forEach(f => f.onsubmit = async e => {
    e.preventDefault();
    try { await saveGoal(f); await refresh(); } catch (err) { $('#goalErr').textContent = err.message; }
  });
  const rf = $('#raceForm');
  if (rf) rf.onsubmit = async e => {
    e.preventDefault();
    const id = Number(rf.id.value), ids = new Set(ctx.meta.manual_races || []); ids.add(id);
    await db.setMeta('manual_races', [...ids]); ctx = await db.loadContext();
    try { await db.setMeta('plan', E.updatePlan(ctx, today())); } catch (err) { alert(err.message); }
    await refresh();
  };
  const cb = $('#coachBtn');
  if (cb) cb.onclick = async () => {
    const t = today(), state = $('#coachState').value.trim();
    ctx.meta.coach_state = state;
    $('#coachTxt').value = buildPrompt(D.report, E.summaryForCoach(ctx, t), { state, memory: ctx.meta.coach_memory, coachCtx: E.coachContext(ctx, t) });
    $('#coachOut').style.display = 'block';
    await db.setMeta('coach_state', state);
  };
  const cr = $('#coachRead');
  if (cr) cr.onclick = () => {
    coachDraft.reply = $('#coachReply').value; $('#coachErr').textContent = '';
    try { coachDraft.pending = E.parseCoachReply(coachDraft.reply, ctx, today()); $('#coachPreview').innerHTML = coachPreview(coachDraft.pending); bind(); $('#coachPreview').scrollIntoView({ block: 'nearest' }); }
    catch (e) { coachDraft.pending = null; $('#coachPreview').innerHTML = ''; $('#coachErr').textContent = e.message; }
  };
  const ca = $('#coachApply');
  if (ca) ca.onclick = async () => {
    const res = coachDraft.pending; if (!res) return;
    try {
      ctx.meta.coach = E.coachRecord(res, today()); await db.setMeta('coach', ctx.meta.coach);
      ctx.meta.coach_memory = E.addCoachMemory(ctx.meta.coach_memory, res.notes, today()); await db.setMeta('coach_memory', ctx.meta.coach_memory);
      await db.setMeta('plan', E.updatePlan(ctx, today()));
      coachDraft = { reply: '', pending: null };
      await refresh(); setStatus(`Séances du coach appliquées ✓ (${res.valid.length}).`);
    } catch (e) { setStatus(e.message, true); }
  };
  const cx = $('#coachCancel'); if (cx) cx.onclick = () => { coachDraft.pending = null; $('#coachPreview').innerHTML = ''; };
  const rv = $('#coachRevert');
  if (rv) rv.onclick = async () => {
    if (!confirm('Revenir au plan automatique ? Les séances du coach seront remplacées.')) return;
    ctx.meta.coach = null; await db.delMeta('coach');
    try { await db.setMeta('plan', E.updatePlan(ctx, today(), true)); } catch (e) { setStatus(e.message, true); }
    await refresh(); setStatus('Plan automatique rétabli.');
  };
  const cm = $('#clearMem'); if (cm) cm.onclick = async () => { await db.setMeta('coach_memory', []); await refresh(); };
  const cp = $('#copyBtn');
  if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText($('#coachTxt').value); } catch { $('#coachTxt').select(); document.execCommand('copy'); } cp.textContent = 'Copié ✓'; setTimeout(() => cp.textContent = 'Copier', 1500); };

  const ver = $('#appVersion'); if (ver) ver.textContent = `App ${APP_VERSION} · plan v${E.PLAN_VERSION}`;
  const rs = $('#raceStrategy');
  if (rs) rs.onchange = async () => { await db.setMeta('course', { ...(ctx.meta.course || {}), strategy: rs.value }); ctx = await db.loadContext(); await refresh(); };
  const cg = $('#courseGpx');
  if (cg) cg.onchange = async () => {
    try { const profile = courseProfileFromGpx(await cg.files[0].text()); await db.setMeta('course', { ...(ctx.meta.course || {}), profile }); ctx = await db.loadContext(); await refresh(); setStatus('Profil du parcours chargé ✓'); }
    catch (e) { setStatus(e.message, true); }
  };
  const cc2 = $('#courseClear'); if (cc2) cc2.onclick = async () => { const c = { ...(ctx.meta.course || {}) }; delete c.profile; await db.setMeta('course', c); ctx = await db.loadContext(); await refresh(); };
  const rtext = () => { const g = ctx.meta.goal, st = ctx.meta.course?.strategy || 'progressive'; return racePlanText(g, racePlan(g, st, ctx.meta.course?.profile || null), STRATEGIES[st].split(' — ')[0]); };
  const rc = $('#raceCopy');
  if (rc) rc.onclick = async () => { try { await navigator.clipboard.writeText(rtext()); } catch { const t = document.createElement('textarea'); t.value = rtext(); document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); } rc.textContent = 'Copié ✓'; setTimeout(() => rc.textContent = 'Copier le plan', 1500); };
  const rsh = $('#raceShare'); if (rsh) rsh.onclick = () => navigator.share({ title: `Plan de course — ${ctx.meta.goal.name}`, text: rtext() }).catch(() => {});
  const inf = $('#inboxForm');
  if (inf) {
    inf.onsubmit = async e => {
      e.preventDefault();
      const url = inf.inboxUrl.value.trim().replace(/\/+$/, ''), token = inf.inboxToken.value.trim();
      if (url && !validInboxUrl(url)) { $('#inboxMsg').innerHTML = '<span class="err">L\'adresse doit commencer par https://</span>'; return; }
      await db.setMeta('settings', { ...ctx.settings, inboxUrl: url, inboxToken: token }); ctx = await db.loadContext();
      setStatus('Boîte de réception enregistrée ✓'); await refresh();
    };
    $('#pullNow').onclick = async () => {
      const url = inf.inboxUrl.value.trim().replace(/\/+$/, ''), token = inf.inboxToken.value.trim();
      if (url && token && (url !== ctx.settings.inboxUrl || token !== ctx.settings.inboxToken)) { await db.setMeta('settings', { ...ctx.settings, inboxUrl: url, inboxToken: token }); ctx = await db.loadContext(); }
      await pullFromInbox(true);
    };
  }
  const hf = $('#hrForm');
  if (hf) hf.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(hf)); for (const k of Object.keys(v)) v[k] = String(v[k]).trim();
    const max = v.fcMax ? Number(v.fcMax) : null, rest = v.fcRepos ? Number(v.fcRepos) : null;
    const zones = v.fcZones ? v.fcZones.split(',').map(x => parseInt(x, 10)) : [];
    const err = (max && (max < 120 || max > 230)) ? 'FC max : entre 120 et 230 bpm.'
      : (rest && (rest < 30 || rest > 100)) ? 'FC repos : entre 30 et 100 bpm.'
      : (max && rest && max - rest < 40) ? 'FC max et FC repos sont trop proches.'
      : (v.fcZones && (zones.length !== 4 || zones.some((z, i) => !Number.isFinite(z) || (i && z <= zones[i - 1])))) ? 'Zones : 4 valeurs croissantes, ex. 114,133,152,171.' : '';
    if (err) { $('#hrErr').textContent = err; return; }
    await db.setMeta('settings', { ...ctx.settings, fcMax: v.fcMax, fcRepos: v.fcRepos, fcZones: v.fcZones });
    ctx = await db.loadContext();
    if (ctx.meta.goal && ctx.meta.plan) { try { await db.setMeta('plan', E.updatePlan(ctx, today())); } catch (e2) { setStatus(e2.message, true); } }
    await refresh(); setStatus('Fréquence cardiaque enregistrée ✓ — niveau et zones recalculés.');
  };
  const uo = $('#useObsHr'); if (uo) uo.onclick = () => { hf.fcMax.value = uo.dataset.hr; hf.fcMax.focus(); };
  const sf = $('#settingsForm');
  if (sf) sf.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(sf));
    for (const k of Object.keys(v)) v[k] = String(v[k]).trim();
    await db.setMeta('settings', { ...ctx.settings, ...v });
    if (ctx.meta.goal && ctx.meta.plan) { ctx = await db.loadContext(); await db.setMeta('plan', E.updatePlan(ctx, today())); }
    setStatus('Réglages enregistrés ✓'); await refresh();
  };
  const cn = $('#connectBtn'); if (cn) cn.onclick = () => { location.href = S.authorizeUrl(ctx.settings); };
  const cf = $('#codeForm');
  if (cf) cf.onsubmit = async e => {
    e.preventDefault();
    const raw = cf.code.value.trim(); if (!raw) return;
    const code = raw.includes('code=') ? new URL(raw.startsWith('http') ? raw : 'http://x/?' + raw.split('?').pop()).searchParams.get('code') : raw;
    try { await S.exchangeCode(ctx.settings, code); setStatus('Connecté à Strava ✓'); view = 'home'; await refresh(); }
    catch (err) { setStatus(err.message, true); }
  };
  const tb = $('#testBtn');
  if (tb) tb.onclick = async () => {
    $('#testOut').textContent = 'Test en cours…';
    const r = await S.testDirect();
    $('#testOut').innerHTML = r.ok
      ? '<span class="ok">✓ Strava accepte les appels directs depuis le navigateur : pas besoin de relais.</span>'
      : '<span class="warn">Strava bloque les appels directs (CORS) ou vous êtes hors ligne. Si vous êtes en ligne : configurez le relais (README).</span>';
  };
  const ex = $('#exportBtn');
  if (ex) ex.onclick = async () => {
    const blob = new Blob([JSON.stringify(await db.exportAll())], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `strava-coach-${today()}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const im = $('#restoreFile');
  if (im) im.onchange = async () => {
    try { await db.importAll(JSON.parse(await im.files[0].text())); setStatus('Sauvegarde importée ✓'); await refresh(); }
    catch (err) { setStatus(err.message, true); }
  };
  const wb = $('#wipeBtn');
  if (wb) wb.onclick = async () => { if (confirm('Effacer toutes les données et réglages de cet appareil ?')) { await db.wipe(); setStatus('Données effacées.'); await refresh(); } };
  const imp = $('#importFile');
  if (imp) imp.onchange = async () => {
    const files = [...imp.files]; if (!files.length) return;
    try {
      const have = new Map((await db.getAll('activities')).map(a => [a.id, a])), hasStream = new Set((await db.getAll('streams')).map(x => x.id));
      let enriched = 0; const before = have.size;
      const st = await importFiles(files, async (acts, streams) => {
        const put = [], putStreams = [], known = [...have.values()];
        for (const a of acts) {
          const same = have.get(a.id);
          if (same) { if (same.source === 'export') put.push(a); continue; }           // ne pas écraser les données de l'API ou saisies à la main
          const dup = findDuplicate(known, a);                                           // même séance déjà connue sous un autre numéro
          if (dup) {
            const fl = streams.find(x => x.id === a.id);
            if (fl && !hasStream.has(dup.id)) { putStreams.push({ ...fl, id: dup.id }); hasStream.add(dup.id); enriched++; if (dup.avg_hr == null && a.avg_hr != null) put.push({ ...dup, avg_hr: a.avg_hr }); }
            continue;
          }
          put.push(a); known.push(a);
        }
        const ids = new Set(put.map(x => x.id));
        await db.putMany('activities', put); await db.putMany('streams', [...putStreams, ...streams.filter(x => ids.has(x.id))]);
        put.forEach(a => have.set(a.id, a));
      }, setStatus);
      ctx = await db.loadContext();
      if (ctx.meta.goal) { try { await db.setMeta('plan', E.updatePlan(ctx, today())); } catch (e) { /* date de course passée, etc. */ } }
      const added = [...have.values()].length - before;
      let msg = `${added} nouvelle(s) activité(s) importée(s)` + (st.imported > added ? `, ${st.imported - added} déjà connue(s)` : '') + (enriched ? `, FC ajoutée à ${enriched} séance(s) existante(s)` : '') + '.';
      if (st.skipped) msg += ` ${st.skipped} fichier(s) ignoré(s)` + (st.errors.length ? ` (${st.errors[0]})` : '') + '.';
      if (!st.found) msg = "Aucun fichier d'activité (FIT, GPX, TCX) trouvé dans cette sélection.";
      setStatus(msg, !st.found); if (added || enriched) view = 'home';
    } catch (e) { setStatus(e.message, true); }
    await refresh();
  };
  document.querySelectorAll('[data-race]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.race), ids = new Set(ctx.meta.manual_races || []);
    ids.has(id) ? ids.delete(id) : ids.add(id);
    await db.setMeta('manual_races', [...ids]); ctx = await db.loadContext();
    if (ctx.meta.goal && ctx.meta.plan) { try { await db.setMeta('plan', E.updatePlan(ctx, today())); } catch (e) { /* ignore */ } }
    await refresh();
  });
  document.querySelectorAll('[data-move]').forEach(btn => btn.onclick = () => {
    const key = btn.dataset.move, row = btn.closest('.sess'), monday = row.dataset.week;
    const w = D.plan.weeks.find(x => x.monday === monday), sess = w.sessions.find(x => x.key === key);
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">Déplacer au…</option>' + Array.from({ length: 7 }, (_, i) => E.addDays(monday, i))
      .filter(d => d >= today() && d !== sess.date && d <= E.addDays(monday, 6))
      .map(d => { const o = w.sessions.find(x => x.date === d); return `<option value="${d}" ${o?.kind === 'race' ? 'disabled' : ''}>${fmtDate(d)}${o ? ' (échange)' : ''}</option>`; }).join('');
    sel.onchange = () => sel.value && movePlanSession(key, sel.value);
    btn.replaceWith(sel); sel.focus();
  });
  const pb = $('#pauseBtn');
  if (pb) pb.onclick = async () => {
    ctx.meta.pause = E.startPause(ctx, today()); await db.setMeta('pause', ctx.meta.pause);
    try { await db.setMeta('plan', E.updatePlan(ctx, today())); setStatus('Pause enregistrée. Prenez soin de vous.'); } catch (e) { setStatus(e.message, true); }
    await refresh();
  };
  const rb = $('#resumeBtn');
  if (rb) rb.onclick = async () => {
    ctx.meta.pause = { ...ctx.meta.pause, to: today() };
    try { await db.setMeta('plan', E.updatePlan(ctx, today())); await db.delMeta('pause'); ctx.meta.pause = null; setStatus('Reprise ✓ — le plan repart prudemment.'); }
    catch (e) { setStatus(e.message, true); }
    await refresh();
  };
  const qr = $('#quickRace');
  if (qr) qr.onsubmit = async e => {
    e.preventDefault();
    const km = Number(qr.km.value);
    try {
      const sec = E.parseGoalTime(qr.time.value, km);
      await addRun({ date: qr.date.value, km, sec, race: true, name: `Course ${km} km (saisie)` });
      await refresh(); setStatus('Course ajoutée ✓ — niveau et allures recalculés.');
    } catch (err) { $('#quickErr').textContent = err.message; }
  };
  const mf = $('#manualForm');
  if (mf) mf.onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(mf)), km = Number(b.km), min = Number(b.min);
    if (!(km > 0) || !(min > 0)) { $('#manualErr').textContent = 'Distance et durée doivent être positives.'; return; }
    await addRun({ date: b.date, sport: b.sport, km, sec: min * 60, hr: b.hr ? Number(b.hr) : null, elev: b.elev ? Math.round(Number(b.elev)) : null, race: !!b.race,
      name: ({ Run: 'Course à pied', TrailRun: 'Trail', Ride: 'Vélo', Walk: 'Marche', Hike: 'Randonnée', Workout: 'Séance' })[b.sport] + ' (saisie)' });
    await refresh(); setStatus('Séance ajoutée ✓ — plan mis à jour.');
  };
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Supprimer cette séance ?')) return;
    await db.del('activities', Number(b.dataset.del)); ctx = await db.loadContext();
    if (ctx.meta.goal && ctx.meta.plan) { try { await db.setMeta('plan', E.updatePlan(ctx, today())); } catch (err) { /* ignore */ } }
    await refresh();
  });
  const cc = $('#copyCode'); if (cc) cc.onclick = async () => { try { await navigator.clipboard.writeText(codeScreen); cc.textContent = 'Copié ✓'; } catch { $('#codeBox').select(); } };
}

$('#tabHome').onclick = () => { view = 'home'; codeScreen = null; render(); };
$('#tabSettings').onclick = () => { view = 'settings'; codeScreen = null; render(); };

/* ---------- démarrage : retour d'autorisation Strava, service worker ---------- */
async function boot() {
  ctx = await db.loadContext(); tokens = await db.getMeta('tokens');
  const q = new URLSearchParams(location.search);
  if (q.has('code') || q.has('error')) {
    history.replaceState({}, '', location.pathname);
    if (q.get('error')) setStatus("Autorisation refusée sur Strava.", true);
    else if (q.get('scope') && !q.get('scope').includes('activity:read')) setStatus("Il faut cocher « Voir toutes vos activités » : recommencez la connexion.", true);
    else if (configured()) {
      try { await S.exchangeCode(ctx.settings, q.get('code')); tokens = await db.getMeta('tokens'); setStatus('Connecté à Strava ✓ — touchez Synchroniser.'); }
      catch (e) { setStatus(e.message, true); }
    } else codeScreen = q.get('code');
  }
  if (ctx.meta.goal && (!ctx.meta.plan || ctx.meta.plan.generated !== today() || ctx.meta.plan.v !== E.PLAN_VERSION)) { // nouveau jour : le plan se recale sur le réalisé
    try { await db.setMeta('plan', E.updatePlan(ctx, today())); ctx = await db.loadContext(); } catch (e) { setStatus(e.message, true); }
  }
  D = E.dashboard(ctx, today());
  render();
  inboxLast = await db.getMeta('inbox_last');
  navigator.storage?.persist?.();
  pullFromInbox(false); // récupération automatique à l'ouverture (sans effet si la boîte n'est pas configurée)
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastPullAt > 60_000) pullFromInbox(false); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot().catch(e => { $('#app').innerHTML = `<div class="card err">Erreur : ${esc(e.message)}</div>`; });
