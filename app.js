import * as E from './engine.js';
import * as db from './db.js';
import * as S from './strava.js';
import { buildPrompt } from './coach.js';
import { importFiles } from './importer.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', {weekday:'short', day:'2-digit', month:'2-digit'});
const hms = s => `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const PHASE = {base:'Base', construction:'Construction', 'spécifique':'Spécifique', 'affûtage':'Affûtage'};
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
    ${D.plan ? `<div class="card kpi" style="margin:0"><div class="l">${esc(D.goal.distance_km)} km aujourd'hui</div><div class="v">${esc(D.plan.predicted)}</div><div class="s muted">objectif ${esc(D.goal.target)}${D.plan.confiance !== 'bonne' ? ' · estimation peu fiable' : ''}</div></div>` : ''}
  </div>`;
}
function goalForm(existing) {
  const g = existing || {};
  return `<form id="goalForm">
    <div><label>Nom de la course</label><input name="name" required value="${esc(g.name || '')}" placeholder="Semi de Lyon"></div>
    <div><label>Distance (km)</label><input name="distance" type="number" step="0.1" min="1" required value="${esc(g.distance_km || 21.1)}"></div>
    <div><label>Date</label><input name="date" type="date" required value="${esc(g.date || '')}"></div>
    <div><label>Temps visé (h:mm:ss)</label><input name="time" required pattern="\\d{1,2}(:\\d{2}){1,2}" value="${esc(g.target_s ? hms(g.target_s) : '')}" placeholder="1:45:00"></div>
    <div><label>Jours de course / semaine</label><select name="days">${[3,4,5,6].map(n => `<option ${n == (g.days || 4) ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div><button class="primary" type="submit">${existing ? 'Mettre à jour l\'objectif' : 'Créer mon plan'}</button></div>
  </form><div id="goalErr" class="err"></div>`;
}
function planSection() {
  if (!D.goal || !D.plan) {
    return `<div class="card"><h2>Mon objectif</h2><p class="muted">Définissez la course visée : le plan se construit à partir de votre niveau actuel et se réajuste à chaque synchronisation.</p>${goalForm(null)}</div>`;
  }
  const p = D.plan, g = D.goal;
  const weeks = p.weeks, ci = Math.max(weeks.findIndex(w => w.current), 0);
  const shown = weeks.slice(ci);
  const icon = {done:'<span class="good" title="Fait">✓</span>', missed:'<span class="bad" title="Manqué">✗</span>', race:'🏁', upcoming:''};
  const wk = (w, open) => `<details ${open ? 'open' : ''}><summary>
      <span><b>${fmtDate(w.monday)}</b> <span class="tag ${w.current ? 'cur' : ''}">${PHASE[w.phase] || w.phase}${w.recovery ? ' · récup' : ''}</span></span>
      <span class="muted">prévu ${Math.round(w.km)} km${w.actual != null ? ` · fait ${Math.round(w.actual)} km` : ''}</span></summary>
      ${w.sessions.map(s => `<div class="sess"><span class="d">${fmtDate(s.date)}</span><span>${esc(s.text)}</span><span>${icon[s.status]}</span></div>`).join('')}
    </details>`;
  return `<div class="card">
    <h2>🎯 ${esc(g.name)} — ${esc(g.distance_km)} km le ${new Date(g.date + 'T12:00').toLocaleDateString('fr-FR', {day:'numeric', month:'long', year:'numeric'})} en ${esc(g.target)} (${esc(g.goal_pace)})</h2>
    <p class="muted" style="margin-top:-6px">Niveau VDOT ${p.vdot} (${esc(p.vdot_source)} — confiance ${esc(p.confiance)}) · objectif VDOT ${p.vdot_objectif}<br>
    Allures : ${Object.entries(p.paces).map(([k, v]) => `<b>${k}</b> ${v}`).join(' · ')}</p>
    ${p.notes.length ? `<ul class="notes">${p.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${shown.slice(0, 3).map((w, i) => wk(w, i < 2)).join('')}
    <details><summary class="muted">Voir toutes les semaines (${shown.length - 3 > 0 ? shown.length - 3 : 0} de plus)</summary>
      ${shown.slice(3).map(w => wk(w, false)).join('')}</details>
    <details><summary class="muted">Modifier l'objectif / signaler une course</summary><div style="padding-top:10px">
      ${goalForm({...g, days: g.days})}
      <p class="muted">Course non étiquetée « Course » sur Strava ? Entrez l'ID de l'activité (dans son URL) :</p>
      <form id="raceForm" style="grid-template-columns:1fr auto"><input name="id" type="number" placeholder="ID activité" required><button>Marquer comme course</button></form>
    </div></details>
  </div>
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
  return `<div class="card"><h2>🧠 Mon coach</h2>
    <p class="muted">Génère un message complet (vos métriques, zones, plan) à coller dans un chat pour obtenir votre bilan et ajustements — gratuit.</p>
    <button id="coachBtn">Générer le message pour le coach</button>
    <div id="coachOut" style="display:none;margin-top:12px"><textarea id="coachTxt" readonly></textarea>
      <button id="copyBtn" class="primary" style="margin-top:8px">Copier</button></div></div>`;
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
  const b = Object.fromEntries(new FormData(f));
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(b.time)) throw new Error('Temps visé invalide (ex. 1:45:00).');
  const g = E.setGoal(b.name, Number(b.distance), b.date, b.time, Number(b.days), today());
  ctx.meta.goal = g; ctx.meta.plan = null;
  await db.setMeta('goal', g);
  await db.setMeta('plan', E.updatePlan(ctx, today(), true));
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

function settingsView() {
  const s = ctx.settings, host = location.host;
  return `<div class="card"><h2>1. Importer mon export Strava <span class="tag">gratuit</span></h2>
    <ol class="steps muted"><li>Sur strava.com : Paramètres › Mon compte › « Télécharger ou supprimer votre compte » › demandez l'archive.</li>
      <li>Téléchargez le ZIP reçu par e-mail (dans Fichiers).</li>
      <li>Touchez ci-dessous et choisissez le ZIP (ou des fichiers FIT / GPX / TCX).</li></ol>
    <input id="importFile" type="file" multiple>
    <p class="muted" style="font-size:13px">Les fichiers FIT contiennent la fréquence cardiaque (zones précises). Les GPX n'en ont pas : seuls la distance, la durée et le dénivelé sont utilisés. Un nouvel import n'ajoute que les nouveautés.</p></div>
  <details class="card"><summary><b>2. Connexion directe à Strava</b> <span class="tag">abonnement Strava requis</span></summary>
    <p class="muted">Strava réserve désormais son API aux abonnés. Inutile si vous importez votre export.</p>
    <h2 style="margin-top:12px">Application Strava</h2>
    <ol class="steps muted"><li>Sur <b>strava.com/settings/api</b>, créez une application (gratuit).</li>
    <li>« Authorization Callback Domain » : <code>${esc(location.hostname)}</code></li>
    <li>Copiez le Client ID (et le Client Secret si vous n'utilisez pas de relais).</li></ol>
    <form id="settingsForm">
      <div><label>Client ID</label><input name="clientId" inputmode="numeric" value="${esc(s.clientId || '')}"></div>
      <div><label>Client Secret <span class="muted">(reste sur ce téléphone)</span></label><input name="clientSecret" type="password" autocomplete="off" value="${esc(s.clientSecret || '')}"></div>
      <div><label>Adresse du relais <span class="muted">(optionnel, voir README)</span></label><input name="relayUrl" inputmode="url" placeholder="https://….workers.dev" value="${esc(s.relayUrl || '')}"></div>
      <div><label>FC max (bpm)</label><input name="fcMax" type="number" inputmode="numeric" value="${esc(s.fcMax || 190)}"></div>
      <div><label>FC repos (bpm)</label><input name="fcRepos" type="number" inputmode="numeric" value="${esc(s.fcRepos || 55)}"></div>
      <div><label>Zones FC manuelles <span class="muted">(limites hautes Z1 à Z4, ex. 114,133,152,171)</span></label><input name="fcZones" value="${esc(s.fcZones || '')}"></div>
      <div><button class="primary" type="submit">Enregistrer</button></div>
    </form></div>
  <div style="margin-top:14px"><h2>Connexion ${tokens ? '<span class="ok">✓ connecté</span>' : ''}</h2>
    <div class="row"><button id="connectBtn" ${configured() ? '' : 'disabled'}>Se connecter à Strava</button><button id="testBtn">Tester la connexion directe</button></div>
    <p class="muted" style="font-size:13px">Si, après l'autorisation, la page s'ouvre dans Safari au lieu de l'app, copiez le code affiché puis collez-le ici :</p>
    <form id="codeForm" style="grid-template-columns:1fr auto"><input name="code" placeholder="Code ou adresse complète" autocomplete="off"><button>Valider</button></form>
    <div id="testOut" class="muted" style="margin-top:8px"></div></div></details>
  <div class="card"><h2>3. Données</h2>
    <p class="muted">Tout est stocké uniquement sur cet appareil. Faites une sauvegarde de temps en temps.</p>
    <div class="row"><button id="exportBtn">Exporter une sauvegarde</button>
      <label style="margin:0"><span class="muted">Restaurer une sauvegarde</span><input id="restoreFile" type="file" accept="application/json"></label></div>
    <button id="wipeBtn" style="color:var(--bad)">Effacer toutes les données</button></div>`;
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
  if (cb) cb.onclick = () => {
    const t = today();
    $('#coachTxt').value = buildPrompt(D.report, E.summaryForCoach(ctx, t));
    $('#coachOut').style.display = 'block';
  };
  const cp = $('#copyBtn');
  if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText($('#coachTxt').value); } catch { $('#coachTxt').select(); document.execCommand('copy'); } cp.textContent = 'Copié ✓'; setTimeout(() => cp.textContent = 'Copier', 1500); };

  const sf = $('#settingsForm');
  if (sf) sf.onsubmit = async e => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(sf));
    for (const k of Object.keys(v)) v[k] = String(v[k]).trim();
    await db.setMeta('settings', v);
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
      const have = new Map((await db.getAll('activities')).map(a => [a.id, a]));
      const st = await importFiles(files, async (acts, streams) => {
        const fresh = acts.filter(a => !have.has(a.id) || have.get(a.id).source === 'export'); // ne pas écraser les données de l'API
        await db.putMany('activities', fresh); await db.putMany('streams', streams);
        fresh.forEach(a => have.set(a.id, a));
      }, setStatus);
      ctx = await db.loadContext();
      if (ctx.meta.goal) { try { await db.setMeta('plan', E.updatePlan(ctx, today())); } catch (e) { /* date de course passée, etc. */ } }
      let msg = `${st.imported} activité(s) importée(s), dont ${st.withHr} avec fréquence cardiaque détaillée.`;
      if (st.skipped) msg += ` ${st.skipped} fichier(s) ignoré(s)` + (st.errors.length ? ` (${st.errors[0]})` : '') + '.';
      if (!st.found) msg = "Aucun fichier d'activité (FIT, GPX, TCX) trouvé dans cette sélection.";
      setStatus(msg, !st.found); if (st.imported) view = 'home';
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
  const mf = $('#manualForm');
  if (mf) mf.onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(mf)), km = Number(b.km), min = Number(b.min);
    if (!(km > 0) || !(min > 0)) { $('#manualErr').textContent = 'Distance et durée doivent être positives.'; return; }
    await db.put('activities', {
      id: Date.now(), name: ({ Run: 'Course à pied', TrailRun: 'Trail', Ride: 'Vélo', Walk: 'Marche', Hike: 'Randonnée', Workout: 'Séance' })[b.sport] + ' (saisie)',
      sport: b.sport, start_date: `${b.date}T12:00:00Z`, distance_m: Math.round(km * 1000), moving_s: Math.round(min * 60),
      elevation_m: b.elev ? Math.round(Number(b.elev)) : null, avg_hr: b.hr ? Number(b.hr) : null, avg_speed: km * 1000 / (min * 60),
      perceived_exertion: null, workout_type: b.race ? 1 : null, source: 'manual',
    });
    ctx = await db.loadContext();
    if (ctx.meta.goal) { try { await db.setMeta('plan', E.updatePlan(ctx, today())); } catch (err) { /* ignore */ } }
    setStatus('Séance ajoutée ✓ — plan mis à jour.'); await refresh();
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
  if (ctx.meta.goal && ctx.meta.plan && ctx.meta.plan.generated !== today()) { // nouveau jour : le plan se recale sur le réalisé
    try { await db.setMeta('plan', E.updatePlan(ctx, today())); ctx = await db.loadContext(); } catch (e) { setStatus(e.message, true); }
  }
  D = E.dashboard(ctx, today());
  render();
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot().catch(e => { $('#app').innerHTML = `<div class="card err">Erreur : ${esc(e.message)}</div>`; });
