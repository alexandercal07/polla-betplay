// Polla BetPlay — SPA sin dependencias
const TZ = 'America/Bogota';
const $app = document.getElementById('app');
const LS = 'pollaGroups';

/* ---------------- utilidades ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d, o) => new Intl.DateTimeFormat('es-CO', { timeZone: TZ, ...o }).format(new Date(d));
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const ymd = (d) => dayKey(d).replace(/-/g, '');
const hhmm = (d) => fmt(d, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s?a\.\s?m\./, ' am').replace(/\s?p\.\s?m\./, ' pm');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data?.error || `Error ${r.status}`);
  return data;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 3200);
}

const store = {
  get() { try { return JSON.parse(localStorage.getItem(LS)) || []; } catch { return []; } },
  set(v) { try { localStorage.setItem(LS, JSON.stringify(v)); } catch {} },
  active() { try { return localStorage.getItem(LS + ':active'); } catch { return null; } },
  setActive(c) { try { localStorage.setItem(LS + ':active', c); } catch {} },
  add(g) { const a = store.get().filter((x) => x.code !== g.code); a.push(g); store.set(a); store.setActive(g.code); },
  remove(code) { store.set(store.get().filter((x) => x.code !== code)); },
  current() { const a = store.get(); return a.find((x) => x.code === store.active()) || a[0] || null; },
};

/* ---------------- datos ESPN ---------------- */
function seasonRange(now = new Date()) {
  const y = Number(fmt(now, { year: 'numeric' }));
  const m = Number(fmt(now, { month: 'numeric' }));
  return m <= 6 ? `${y}0101-${y}0630` : `${y}0701-${y}1231`;
}

function parseEvent(ev) {
  const c = ev.competitions?.[0] || {};
  const st = c.status?.type || ev.status?.type || {};
  const status = c.status || ev.status || {};
  const team = (side) => {
    const x = (c.competitors || []).find((k) => k.homeAway === side) || {};
    return {
      id: x.team?.id, name: x.team?.shortDisplayName || x.team?.displayName || '—', full: x.team?.displayName,
      logo: x.team?.logo || x.team?.logos?.[0]?.href || '', score: x.score?.value ?? x.score, winner: x.winner,
      shootout: x.shootoutScore,
    };
  };
  return {
    id: ev.id, date: c.date || ev.date, state: st.state, name: st.name, completed: st.completed,
    clock: status.displayClock, short: st.shortDetail || st.detail, detail: st.detail,
    home: team('home'), away: team('away'),
    venue: c.venue?.fullName, city: c.venue?.address?.city,
    note: c.notes?.[0]?.headline || ev.season?.slug?.replace(/-/g, ' ') || '',
    details: c.details || [],
  };
}

function statusLabel(e) {
  if (/POSTPONED/.test(e.name || '')) return 'Aplazado';
  if (/CANCEL/.test(e.name || '')) return 'Cancelado';
  if (/SUSPENDED|ABANDONED/.test(e.name || '')) return 'Suspendido';
  if (e.state === 'in') {
    if (/HALFTIME/.test(e.name || '')) return 'Entretiempo';
    return e.clock || 'En vivo';
  }
  if (e.state === 'post') return e.home.shootout != null ? 'Final (pen.)' : 'Final';
  return hhmm(e.date);
}

const logo = (url, cls = 'logo') => url ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" onerror="this.className='${cls} ph';this.removeAttribute('src')">` : `<span class="${cls} ph"></span>`;

/* ---------------- estado global ---------------- */
const S = { events: [], loadedAt: 0, myBets: {}, filter: 'todos', timer: null, view: null };

async function loadEvents(force) {
  if (!force && Date.now() - S.loadedAt < 15000 && S.events.length) return S.events;
  const data = await api(`/api/espn?kind=scoreboard&dates=${seasonRange()}`);
  S.events = (data.events || []).map(parseEvent).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  S.loadedAt = Date.now();
  document.getElementById('liveDot').hidden = !S.events.some((e) => e.state === 'in');
  return S.events;
}

async function loadMyBets() {
  const g = store.current();
  if (!g) return (S.myBets = {});
  try {
    const { bets } = await api(`/api/bets?code=${g.code}&token=${g.token}`);
    S.myBets = Object.fromEntries(bets.filter((b) => b.mine).map((b) => [b.eventId, b]));
  } catch { S.myBets = {}; }
  return S.myBets;
}

function betOutcome(bet, e) {
  if (!bet || e.state !== 'post') return '';
  const h = Number(e.home.score), a = Number(e.away.score);
  if (bet.home === h && bet.away === a) return 'exact';
  if (Math.sign(bet.home - bet.away) === Math.sign(h - a)) return 'winner';
  return 'miss';
}

/* polling: rápido si hay partidos en vivo o por empezar */
function schedule(fn) {
  clearTimeout(S.timer);
  const now = Date.now();
  const live = S.events.some((e) => e.state === 'in');
  const soon = S.events.some((e) => e.state === 'pre' && Date.parse(e.date) - now < 15 * 60e3 && Date.parse(e.date) > now - 3 * 3600e3);
  const ms = live ? 30e3 : soon ? 60e3 : 5 * 60e3;
  S.timer = setTimeout(async () => { if (!document.hidden) await fn(); else schedule(fn); }, ms);
}

/* ---------------- router ---------------- */
function route() {
  clearTimeout(S.timer);
  const h = location.hash.slice(1) || 'partidos';
  const [view, arg] = [h.split('-')[0], h.split('-').slice(1).join('-')];
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (view === 'partido' ? 'partidos' : view === 'unirse' ? 'grupos' : view)));
  S.view = h;
  window.scrollTo(0, 0);
  if (view === 'partido' && /^\d+$/.test(arg)) return viewMatch(arg);
  if (view === 'tabla') return viewTable();
  if (view === 'grupos') return viewGroups();
  if (view === 'unirse') return viewGroups(arg);
  return viewMatches();
}
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.view) route(); });

/* ================= VISTA 1: PARTIDOS ================= */
async function viewMatches(silent) {
  if (!silent) $app.innerHTML = '<div class="loading">Cargando partidos…</div>';
  try {
    await Promise.all([loadEvents(silent), loadMyBets()]);
  } catch (e) {
    $app.innerHTML = `<div class="err">No se pudieron cargar los partidos: ${esc(e.message)}</div>`;
    return;
  }
  if (S.view !== (location.hash.slice(1) || 'partidos')) return;
  renderMatches();
  schedule(() => viewMatches(true));
}

function renderMatches() {
  const f = S.filter;
  let evs = S.events;
  if (f === 'vivo') evs = evs.filter((e) => e.state === 'in');
  if (f === 'proximos') evs = evs.filter((e) => e.state === 'pre');
  if (f === 'resultados') evs = evs.filter((e) => e.state === 'post').reverse();
  if (f === 'apuestas') evs = evs.filter((e) => S.myBets[e.id]);

  const liveN = S.events.filter((e) => e.state === 'in').length;
  const chips = [['todos', 'Todos'], ['vivo', `En vivo${liveN ? ` (${liveN})` : ''}`], ['proximos', 'Próximos'], ['resultados', 'Resultados'], ['apuestas', 'Mis apuestas']]
    .map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('');

  const today = dayKey(new Date());
  const groups = new Map();
  for (const e of evs) {
    const k = dayKey(e.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const days = [...groups.entries()].map(([k, list]) => {
    const d = list[0].date;
    const label = k === today ? 'Hoy' : cap(fmt(d, { weekday: 'long', day: 'numeric', month: 'long' }));
    const note = list.find((e) => e.note)?.note || '';
    return `<section class="day ${k === today ? 'today' : ''}" data-day="${k}">
      <div class="day-h"><span>${esc(label)}</span><small>${esc(cap(note))} · ${list.length} partido${list.length > 1 ? 's' : ''}</small></div>
      ${list.map(matchRow).join('')}
    </section>`;
  }).join('');

  $app.innerHTML = `<div class="chips">${chips}</div>${days || `<div class="empty">${f === 'vivo' ? 'No hay partidos en vivo ahora.' : f === 'apuestas' ? 'Aún no tienes apuestas en tu polla activa.' : 'No hay partidos para mostrar.'}</div>`}`;
  $app.querySelectorAll('.chip').forEach((b) => b.onclick = () => { S.filter = b.dataset.f; renderMatches(); });
  $app.querySelectorAll('.m').forEach((m) => m.onclick = () => (location.hash = 'partido-' + m.dataset.id));

  if (f === 'todos' && !renderMatches._scrolled) {
    renderMatches._scrolled = true;
    const target = [...$app.querySelectorAll('.day')].find((s) => s.dataset.day >= today);
    if (target) target.scrollIntoView({ block: 'start' }), window.scrollBy(0, -110);
  }
}

function matchRow(e) {
  const live = e.state === 'in';
  const played = e.state !== 'pre' && e.home.score != null && e.home.score !== '';
  const center = played
    ? `<div class="sc">${esc(e.home.score)} - ${esc(e.away.score)}</div><div class="st">${esc(statusLabel(e))}</div>`
    : `<div class="tm">${esc(statusLabel(e))}</div>`;
  const bet = S.myBets[e.id];
  const oc = betOutcome(bet, e);
  const betTag = bet ? `<div class="mybet ${oc}">Tu pick ${bet.home}-${bet.away}${oc === 'exact' ? ' · +exacto' : oc === 'winner' ? ' · +acierto' : ''}</div>` : '';
  return `<div class="m ${live ? 'live' : ''}" data-id="${esc(e.id)}">
    <div class="t ${e.home.winner ? 'w' : ''}">${logo(e.home.logo)}<span>${esc(e.home.name)}</span></div>
    <div class="c">${center}</div>
    <div class="t away ${e.away.winner ? 'w' : ''}">${logo(e.away.logo)}<span>${esc(e.away.name)}</span></div>
    ${betTag}
  </div>`;
}

/* ================= POSICIONES ================= */
async function viewTable() {
  $app.innerHTML = '<div class="loading">Cargando tabla…</div>';
  try {
    const data = await api('/api/espn?kind=standings');
    const groups = (data.children?.length ? data.children : [data]).filter((c) => c.standings?.entries?.length);
    if (!groups.length) { $app.innerHTML = '<div class="empty">La tabla no está disponible todavía.</div>'; return; }
    const stat = (en, ...names) => {
      for (const n of names) { const s = en.stats?.find((x) => x.name === n || x.abbreviation === n || x.type === n); if (s) return s.displayValue ?? s.value; }
      return '–';
    };
    $app.innerHTML = groups.map((g) => {
      const entries = [...g.standings.entries].sort((a, b) => Number(stat(a, 'rank')) - Number(stat(b, 'rank')));
      const single = groups.length === 1;
      return `<div class="card" style="padding:0;overflow:hidden">
        <div class="day-h"><span>${esc(g.name || g.abbreviation || 'Tabla')}</span><small>${esc(data.seasons?.[0]?.displayName || '')}</small></div>
        <table class="tbl"><thead><tr><th>#</th><th style="text-align:left">Equipo</th><th>PJ</th><th>G</th><th>E</th><th>P</th><th>DG</th><th>Pts</th></tr></thead><tbody>
        ${entries.map((en, i) => `<tr class="${single && i < 8 ? 'q' : ''}">
          <td>${esc(stat(en, 'rank') !== '–' ? stat(en, 'rank') : i + 1)}</td>
          <td class="tn"><div>${logo(en.team?.logos?.[0]?.href || en.team?.logo)}<span>${esc(en.team?.shortDisplayName || en.team?.displayName)}</span></div></td>
          <td>${esc(stat(en, 'gamesPlayed', 'GP'))}</td><td>${esc(stat(en, 'wins', 'W'))}</td><td>${esc(stat(en, 'ties', 'D'))}</td><td>${esc(stat(en, 'losses', 'L'))}</td>
          <td>${esc(stat(en, 'pointDifferential', 'GD'))}</td><td class="pts">${esc(stat(en, 'points', 'P'))}</td></tr>`).join('')}
        </tbody></table>
        ${single ? '<div class="legend"><i></i>Clasifican a cuadrangulares (top 8)</div>' : ''}
      </div>`;
    }).join('');
  } catch (e) {
    $app.innerHTML = `<div class="err">No se pudo cargar la tabla: ${esc(e.message)}</div>`;
  }
}

/* ================= VISTA 2: DETALLE ================= */
const D = { tab: 'resumen', lineupSide: 'home', data: null, id: null };

async function viewMatch(id, silent) {
  if (!silent) {
    if (D.id !== id) { D.tab = 'resumen'; D.lineupSide = 'home'; }
    D.id = id;
    $app.innerHTML = '<div class="loading">Cargando partido…</div>';
  }
  try {
    const [data] = await Promise.all([api(`/api/espn?kind=summary&event=${id}`), loadMyBets()]);
    D.data = data;
  } catch (e) {
    $app.innerHTML = `<a class="back" href="#partidos">← Partidos</a><div class="err">No se pudo cargar el partido: ${esc(e.message)}</div>`;
    return;
  }
  if (S.view !== 'partido-' + id) return;
  renderMatch();
  const st = D.data.header?.competitions?.[0]?.status?.type?.state;
  clearTimeout(S.timer);
  const ms = st === 'in' ? 20e3 : st === 'pre' ? 120e3 : 0;
  if (ms) S.timer = setTimeout(() => !document.hidden && viewMatch(id, true), ms);
}

function renderMatch() {
  const d = D.data;
  const comp = d.header?.competitions?.[0] || {};
  const e = parseEvent({ id: D.id, competitions: [comp] });
  const gi = d.gameInfo || {};
  const venue = gi.venue?.fullName || e.venue;
  const city = gi.venue?.address?.city || e.city;
  const ref = gi.officials?.[0]?.displayName || gi.officials?.[0]?.fullName;
  const played = e.state !== 'pre';
  const evs = keyEvents(d, e);
  const goals = evs.filter((x) => x.kind === 'goal');
  const scorerList = (side) => goals.filter((g) => g.side === side).map((g) => `${esc(g.who)} ${esc(g.min)}${g.og ? ' (AG)' : g.pen ? ' (P)' : ''}`).join('<br>');

  const hero = `<div class="hero ${e.state === 'in' ? 'live' : ''}">
    <div class="comp">Liga BetPlay Dimayor${e.note ? ' · ' + esc(cap(e.note)) : ''}${d.header?.season?.name ? ' · ' + esc(d.header.season.name) : ''}</div>
    <div class="row">
      <div class="tt">${logo(e.home.logo)}<span>${esc(e.home.full || e.home.name)}</span></div>
      <div class="score">${played ? `${esc(e.home.score)} - ${esc(e.away.score)}` : esc(hhmm(e.date))}
        <small>${played ? esc(statusLabel(e)) : esc(cap(fmt(e.date, { weekday: 'short', day: 'numeric', month: 'short' })))}</small>
        ${e.home.shootout != null ? `<small>Penales ${esc(e.home.shootout)} - ${esc(e.away.shootout)}</small>` : ''}</div>
      <div class="tt">${logo(e.away.logo)}<span>${esc(e.away.full || e.away.name)}</span></div>
    </div>
    ${goals.length ? `<div class="scorers"><div>${scorerList('home')}</div><div>${scorerList('away')}</div></div>` : ''}
    <div class="meta">
      <span>📅 ${esc(cap(fmt(e.date, { weekday: 'long', day: 'numeric', month: 'long' })))} · ${esc(hhmm(e.date))}</span>
      ${venue ? `<span>🏟️ ${esc(venue)}${city ? ', ' + esc(city) : ''}</span>` : ''}
      ${gi.attendance ? `<span>👥 ${Number(gi.attendance).toLocaleString('es-CO')}</span>` : ''}
      ${ref ? `<span>🧑‍⚖️ ${esc(ref)}</span>` : ''}
    </div>
  </div>`;

  const tabs = [['resumen', 'Resumen'], ['alineaciones', 'Alineaciones'], ['estadisticas', 'Estadísticas'], ['apuesta', 'Apuesta']]
    .map(([k, l]) => `<button data-t="${k}" class="${D.tab === k ? 'on' : ''}">${l}</button>`).join('');

  let body = '';
  if (D.tab === 'resumen') body = renderTimeline(evs, e);
  if (D.tab === 'alineaciones') body = renderLineups(d, e);
  if (D.tab === 'estadisticas') body = renderStats(d, e);
  if (D.tab === 'apuesta') body = '<div id="betArea"><div class="loading">Cargando apuestas…</div></div>';

  $app.innerHTML = `<a class="back" href="#partidos">← Partidos</a>${hero}<div class="subtabs">${tabs}</div>${body}`;
  $app.querySelectorAll('.subtabs button').forEach((b) => b.onclick = () => { D.tab = b.dataset.t; renderMatch(); });
  $app.querySelectorAll('[data-side]').forEach((b) => b.onclick = () => { D.lineupSide = b.dataset.side; renderMatch(); });
  if (D.tab === 'apuesta') renderBetArea(e);
}

function keyEvents(d, e) {
  const sideOf = (teamId, teamName) => (String(teamId) === String(e.home.id) || teamName === e.home.full) ? 'home' : 'away';
  const out = [];
  const src = d.keyEvents?.length ? d.keyEvents : null;
  if (src) {
    for (const k of src) {
      const t = (k.type?.type || k.type?.text || '').toLowerCase();
      const min = k.clock?.displayValue || '';
      const who = k.participants?.map((p) => p.athlete?.displayName).filter(Boolean) || [];
      if (/half-?time|halftime/.test(t)) { out.push({ kind: 'sep', label: 'ENTRETIEMPO' }); continue; }
      if (/end|kickoff|start/.test(t) && !k.scoringPlay) continue;
      const side = sideOf(k.team?.id, k.team?.displayName);
      if (k.scoringPlay || /goal/.test(t)) out.push({ kind: 'goal', side, min, who: who[0] || 'Gol', assist: who[1], og: /own/.test(t), pen: /penalty/.test(t) });
      else if (/red/.test(t)) out.push({ kind: 'red', side, min, who: who[0] || '' });
      else if (/yellow/.test(t)) out.push({ kind: 'yellow', side, min, who: who[0] || '' });
      else if (/substitution/.test(t)) out.push({ kind: 'sub', side, min, who: who[0] || '', out: who[1] || '' });
    }
  } else {
    for (const k of e.details) {
      const side = sideOf(k.team?.id);
      const who = k.athletesInvolved?.[0]?.displayName || '';
      const min = k.clock?.displayValue || '';
      if (k.scoringPlay) out.push({ kind: 'goal', side, min, who, og: k.ownGoal, pen: k.penaltyKick });
      else if (k.redCard) out.push({ kind: 'red', side, min, who });
      else if (k.yellowCard) out.push({ kind: 'yellow', side, min, who });
    }
  }
  return out;
}

function renderTimeline(evs, e) {
  if (e.state === 'pre') return '<div class="card"><div class="muted">El partido aún no empieza. Aquí verás goles, tarjetas y cambios minuto a minuto.</div></div>';
  if (!evs.length) return '<div class="card"><div class="muted">Sin eventos registrados todavía.</div></div>';
  const ic = { goal: '⚽', yellow: '🟨', red: '🟥', sub: '🔁' };
  const txt = (x) => x.kind === 'sub'
    ? `${esc(x.who)}<br><small>sale ${esc(x.out)}</small>`
    : `${esc(x.who)}${x.og ? ' <small>(autogol)</small>' : x.pen ? ' <small>(penal)</small>' : ''}${x.assist ? `<br><small>asist. ${esc(x.assist)}</small>` : ''}`;
  return `<div class="card"><ul class="tl">${evs.map((x) => x.kind === 'sep'
    ? `<li><span class="sep">${x.label}</span></li>`
    : `<li><div class="h">${x.side === 'home' ? `${txt(x)} ${ic[x.kind]}` : ''}</div><div class="min">${esc(x.min)}</div><div class="a">${x.side === 'away' ? `${ic[x.kind]} ${txt(x)}` : ''}</div></li>`).join('')}</ul></div>`;
}

function renderLineups(d, e) {
  const rosters = d.rosters || [];
  if (!rosters.some((r) => r.roster?.length)) return '<div class="card"><div class="muted">Las alineaciones se publican normalmente ~1 hora antes del partido.</div></div>';
  const side = D.lineupSide;
  const r = rosters.find((x) => x.homeAway === side) || rosters[side === 'home' ? 0 : 1] || rosters[0];
  const team = side === 'home' ? e.home : e.away;
  const btns = ['home', 'away'].map((s) => `<button data-side="${s}" class="${s === side ? 'on' : ''}">${esc((s === 'home' ? e.home : e.away).name)}</button>`).join('');
  const starters = (r.roster || []).filter((p) => p.starter);
  const subs = (r.roster || []).filter((p) => !p.starter);
  const lines = buildLines(starters, r.formation);
  const badge = (p) => {
    const st = p.stats || [];
    const g = Number(st.find((s) => s.name === 'totalGoals')?.value || 0);
    const y = Number(st.find((s) => s.name === 'yellowCards')?.value || 0);
    const rc = Number(st.find((s) => s.name === 'redCards')?.value || 0);
    return (g ? '⚽'.repeat(Math.min(g, 3)) : '') + (rc ? '🟥' : y ? '🟨' : '') + (p.subbedOut ? '🔻' : '');
  };
  const short = (n) => { const parts = String(n || '').split(' '); return parts.length > 1 ? parts.slice(1).join(' ') : n; };
  const pitch = lines
    ? `<div class="pitch"><div class="box t"></div><div class="box b"></div><div class="lines">${lines.map((ln, i) => `<div class="ln">${ln.map((p) => `
        <div class="pl ${i === 0 ? 'gk' : ''}"><div class="n">${esc(p.jersey ?? '')}<span class="bd">${badge(p)}</span></div><div class="nm">${esc(short(p.athlete?.displayName))}</div></div>`).join('')}</div>`).join('')}</div></div>`
    : `<div class="subs">${starters.map((p) => `<div><b>${esc(p.jersey ?? '')}</b>${esc(p.athlete?.displayName)} ${badge(p)}</div>`).join('')}</div>`;
  return `<div class="subtabs">${btns}</div>
    <div class="card">
      <div class="formation"><span>${logo(team.logo)}</span><span>Formación <b style="color:var(--tx)">${esc(r.formation || '—')}</b></span></div>
      ${pitch}
      ${subs.length ? `<h3 style="margin-top:16px">Suplentes</h3><div class="subs">${subs.map((p) => `<div><b>${esc(p.jersey ?? '')}</b>${esc(p.athlete?.displayName)} ${p.subbedIn ? '🔺' : ''}</div>`).join('')}</div>` : ''}
    </div>`;
}

// Arma líneas (portero → delanteros) a partir de posición + formación (ej. 4-2-3-1)
function buildLines(starters, formation) {
  if (starters.length < 7) return null;
  const cat = (p) => {
    const a = String(p.position?.abbreviation || p.position?.name || '').toUpperCase();
    if (/^(G|GK|POR)/.test(a)) return 0;
    if (/^(D|CD|CB|LB|RB|LWB|RWB|SW|DEF)/.test(a)) return 1;
    if (/^(F|CF|ST|LF|RF|LW|RW|SS|FW|DEL)/.test(a)) return 3;
    return 2;
  };
  const sorted = [...starters].sort((a, b) => cat(a) - cat(b) || (a.formationPlace ?? 99) - (b.formationPlace ?? 99));
  const counts = String(formation || '').split('-').map(Number).filter((n) => n > 0);
  if (counts.length && counts.reduce((a, b) => a + b, 0) + 1 === sorted.length) {
    const lines = [[sorted[0]]];
    let i = 1;
    for (const c of counts) { lines.push(sorted.slice(i, i + c)); i += c; }
    return lines;
  }
  const lines = [[], [], [], []];
  sorted.forEach((p) => lines[cat(p)].push(p));
  return lines.filter((l) => l.length);
}

function renderStats(d, e) {
  const teams = d.boxscore?.teams || [];
  if (teams.length < 2 || !teams[0].statistics?.length) return `<div class="card"><div class="muted">${e.state === 'pre' ? 'Las estadísticas aparecen cuando empieza el partido.' : 'Estadísticas no disponibles para este partido.'}</div></div>`;
  const home = teams.find((t) => String(t.team?.id) === String(e.home.id)) || teams[0];
  const away = teams.find((t) => t !== home) || teams[1];
  const want = ['possessionPct', 'totalShots', 'shotsOnTarget', 'wonCorners', 'foulsCommitted', 'yellowCards', 'redCards', 'offsides', 'saves', 'accuratePasses', 'totalPasses'];
  const hs = Object.fromEntries(home.statistics.map((s) => [s.name, s]));
  const as = Object.fromEntries(away.statistics.map((s) => [s.name, s]));
  const names = [...want.filter((n) => hs[n]), ...Object.keys(hs).filter((n) => !want.includes(n))].slice(0, 14);
  return `<div class="card">${names.map((n) => {
    const h = parseFloat(hs[n]?.displayValue) || 0, a = parseFloat(as[n]?.displayValue) || 0;
    const tot = h + a || 1;
    const lbl = hs[n].label || n;
    const pct = n === 'possessionPct' ? '%' : '';
    return `<div class="stat"><div class="lb"><b>${esc(hs[n].displayValue)}${pct}</b><span>${esc(lbl)}</span><b>${esc(as[n]?.displayValue ?? '0')}${pct}</b></div>
      <div class="bars"><i><b style="width:${(h / tot) * 100}%"></b></i><i><b style="width:${(a / tot) * 100}%"></b></i></div></div>`;
  }).join('')}</div>`;
}

async function renderBetArea(e) {
  const el = document.getElementById('betArea');
  const groups = store.get();
  if (!groups.length) {
    el.innerHTML = `<div class="card"><div class="muted">Para apostar primero crea o únete a una polla.</div><div style="margin-top:10px"><a class="btn" href="#grupos">Ir a Mis pollas</a></div></div>`;
    return;
  }
  const g = store.current();
  const open = e.state === 'pre' && Date.now() < Date.parse(e.date);
  let bets = [];
  try { ({ bets } = await api(`/api/bets?code=${g.code}&token=${g.token}&event=${D.id}`)); } catch (err) { el.innerHTML = `<div class="err">${esc(err.message)}</div>`; return; }
  const mine = bets.find((b) => b.mine);
  const form = open ? `<div class="card">
      <h3>Tu pronóstico ${groups.length > 1 ? `<span class="muted">(se guarda en tus ${groups.length} pollas)</span>` : ''}</h3>
      <div class="betbox">
        <div style="text-align:center">${logo(e.home.logo)}</div>
        <input class="in nb" id="bh" type="number" min="0" max="20" inputmode="numeric" value="${mine?.home ?? ''}">
        <span>-</span>
        <input class="in nb" id="ba" type="number" min="0" max="20" inputmode="numeric" value="${mine?.away ?? ''}">
        <div style="text-align:center">${logo(e.away.logo)}</div>
      </div>
      <button class="btn" id="saveBet" style="width:100%">${mine ? 'Actualizar apuesta' : 'Guardar apuesta'}</button>
      <div class="muted" style="margin-top:8px;text-align:center">Se cierra al pitazo inicial · ${esc(hhmm(e.date))}</div>
    </div>`
    : `<div class="card"><div class="muted">${e.state === 'pre' ? 'Apuestas cerradas.' : 'Apuestas cerradas: el partido ya empezó.'}</div></div>`;
  const oc = (b) => b.hidden ? '' : betOutcome(b, e);
  const pts = (k) => k === 'exact' ? `+${g.pts_exact ?? 3}` : k === 'winner' ? `+${g.pts_winner ?? 1}` : k === 'miss' ? '0' : '';
  const list = `<div class="card"><h3>Apuestas en «${esc(g.groupName)}»</h3>
    ${bets.length ? bets.map((b) => { const k = oc(b); return `<div class="row-between" style="padding:8px 0;border-top:1px solid var(--line)">
      <span>${esc(b.name)}${b.mine ? ' <span class="pill">tú</span>' : ''}</span>
      <span>${b.hidden ? '<span class="muted">🔒 oculta hasta el inicio</span>' : `<b>${b.home} - ${b.away}</b>`} ${k ? `<span class="pill ${k}">${pts(k)}</span>` : ''}</span></div>`; }).join('') : '<div class="muted">Nadie ha apostado todavía.</div>'}
  </div>`;
  el.innerHTML = form + list;
  const btn = document.getElementById('saveBet');
  if (btn) btn.onclick = async () => {
    const h = document.getElementById('bh').value, a = document.getElementById('ba').value;
    if (h === '' || a === '') return toast('Escribe los dos marcadores', true);
    btn.disabled = true;
    try {
      await post('/api/bets', { tokens: store.get().map((x) => x.token), eventId: D.id, home: Number(h), away: Number(a) });
      toast('Apuesta guardada ✅');
      renderBetArea(e);
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  };
}

/* ================= VISTA 3: POLLAS / LEADERBOARD ================= */
async function viewGroups(joinCode) {
  const groups = store.get();
  if (joinCode && !groups.some((g) => g.code === joinCode.toUpperCase())) return renderGroupForms(joinCode.toUpperCase());
  if (!groups.length) return renderGroupForms();
  if (joinCode) store.setActive(joinCode.toUpperCase());
  const g = store.current();
  $app.innerHTML = '<div class="loading">Cargando polla…</div>';
  let lb, upcoming;
  try {
    [lb] = await Promise.all([api(`/api/leaderboard?code=${g.code}`), loadEvents(), loadMyBets()]);
  } catch (e) {
    $app.innerHTML = `<div class="err">${esc(e.message)}</div>${groupSwitcher(g)}`;
    bindSwitcher();
    return;
  }
  Object.assign(g, lb.group, { groupName: lb.group.name });
  store.add(g);
  const now = Date.now();
  upcoming = S.events.filter((e) => e.state === 'pre' && Date.parse(e.date) > now).slice(0, 12);
  const meName = g.memberName;
  const link = `${location.origin}/#unirse-${g.code}`;

  $app.innerHTML = `
    ${groupSwitcher(g)}
    <div class="card">
      <div class="row-between"><h3 style="margin:0">🏆 ${esc(lb.group.name)}</h3><span class="muted">Exacto ${lb.group.pts_exact} · Acierto ${lb.group.pts_winner}</span></div>
      <div class="lb" style="margin-top:10px">
        <div class="rank hd"><span class="pos">#</span><span>Jugador</span><span class="p">Exactos</span><span class="p">Aciertos</span><span class="pt">Pts</span></div>
        ${lb.rows.map((r, i) => `<div class="rank ${r.name === meName ? 'me' : ''}"><span class="pos">${i + 1}</span><span>${esc(r.name)}${r.pending ? ` <span class="muted">· ${r.pending} pend.</span>` : ''}</span><span class="p">${r.exact}</span><span class="p">${r.winner}</span><span class="pt">${r.pts}</span></div>`).join('')}
      </div>
    </div>

    <div class="card">
      <h3>Apostar próximos partidos</h3>
      ${upcoming.length ? upcoming.map((e) => { const b = S.myBets[e.id]; return `<div class="betrow" data-id="${e.id}">
        <div class="when">${esc(cap(fmt(e.date, { weekday: 'short', day: 'numeric', month: 'short' })))} · ${esc(hhmm(e.date))}</div>
        <span class="h">${esc(e.home.name)}</span>
        <span class="ins"><input class="in" type="number" min="0" max="20" inputmode="numeric" data-h value="${b?.home ?? ''}">-<input class="in" type="number" min="0" max="20" inputmode="numeric" data-a value="${b?.away ?? ''}"></span>
        <span>${esc(e.away.name)}</span>
        <button class="btn sm ${b ? 'ghost' : ''}" data-save>${b ? '✓' : 'Guardar'}</button>
      </div>`; }).join('') : '<div class="muted">No hay partidos próximos programados.</div>'}
    </div>

    <div class="card">
      <h3>Invitar amigos</h3>
      <div class="row-between"><span class="code">${esc(g.code)}</span><button class="btn sm" id="copyLink">Copiar link</button></div>
      <div class="muted" style="margin-top:6px;word-break:break-all">${esc(link)}</div>
    </div>

    ${lb.history.length ? `<div class="card"><h3>Últimos resultados</h3><div class="hist">${lb.history.slice(0, 30).map((h) => `<div><span>${esc(h.name)} · <span class="muted">${esc(h.homeTeam)} ${h.result[0]}-${h.result[1]} ${esc(h.awayTeam)}</span></span><span>${h.bet[0]}-${h.bet[1]} <span class="pill ${h.kind}">+${h.pts}</span></span></div>`).join('')}</div></div>` : ''}

    <div class="card">
      <details><summary>Configuración y llave personal</summary>
        <div class="f" style="margin-top:12px">
          ${g.isAdmin ? `
          <div class="grid2">
            <div><label>Nombre de la polla</label><input class="in" id="cfgName" value="${esc(lb.group.name)}"></div>
            <div><label>Contar partidos desde (opcional)</label><input class="in" id="cfgSince" type="date" value="${esc(lb.group.since || '')}"></div>
            <div><label>Puntos por marcador exacto</label><input class="in" id="cfgExact" type="number" min="0" max="20" value="${lb.group.pts_exact}"></div>
            <div><label>Puntos por acertar ganador/empate</label><input class="in" id="cfgWin" type="number" min="0" max="20" value="${lb.group.pts_winner}"></div>
          </div>
          <button class="btn" id="cfgSave">Guardar configuración</button>` : '<div class="muted">Solo quien creó la polla puede cambiar su configuración.</div>'}
          <label>Tu llave personal (para entrar desde otro dispositivo — no la compartas)</label>
          <div class="row-between"><input class="in" readonly value="${esc(g.token)}" style="flex:1"><button class="btn sm ghost" id="copyKey">Copiar</button></div>
          <button class="btn ghost" id="leave">Salir de esta polla en este dispositivo</button>
        </div>
      </details>
    </div>`;

  bindSwitcher();
  document.getElementById('copyLink').onclick = () => copy(link, 'Link copiado');
  document.getElementById('copyKey').onclick = () => copy(g.token, 'Llave copiada');
  document.getElementById('leave').onclick = () => {
    const b = document.getElementById('leave');
    if (b.dataset.sure) { store.remove(g.code); location.hash = 'grupos'; route(); }
    else { b.dataset.sure = 1; b.textContent = 'Toca otra vez para confirmar (guarda tu llave antes)'; }
  };
  const cs = document.getElementById('cfgSave');
  if (cs) cs.onclick = async () => {
    cs.disabled = true;
    try {
      await post('/api/groups', { action: 'update', code: g.code, token: g.token, name: val('cfgName'), since: val('cfgSince'), ptsExact: val('cfgExact'), ptsWinner: val('cfgWin') });
      toast('Configuración guardada');
      viewGroups();
    } catch (e) { toast(e.message, true); cs.disabled = false; }
  };
  $app.querySelectorAll('.betrow [data-save]').forEach((btn) => btn.onclick = async () => {
    const row = btn.closest('.betrow');
    const h = row.querySelector('[data-h]').value, a = row.querySelector('[data-a]').value;
    if (h === '' || a === '') return toast('Escribe los dos marcadores', true);
    btn.disabled = true;
    try {
      await post('/api/bets', { tokens: store.get().map((x) => x.token), eventId: row.dataset.id, home: Number(h), away: Number(a) });
      btn.textContent = '✓'; btn.classList.add('ghost'); toast('Apuesta guardada ✅');
      S.myBets[row.dataset.id] = { home: Number(h), away: Number(a), mine: true };
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
  });
  schedule(() => S.view.startsWith('grupos') || S.view.startsWith('unirse') ? viewGroups() : null);
}

const val = (id) => document.getElementById(id)?.value;
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('No se pudo copiar; selecciónalo manualmente', true); }
}

function groupSwitcher(g) {
  const all = store.get();
  return `<div class="row-between" style="margin:4px 0 8px">
    <select class="in" id="gsel" style="flex:1;max-width:420px">${all.map((x) => `<option value="${esc(x.code)}" ${x.code === g.code ? 'selected' : ''}>${esc(x.groupName)} · ${esc(x.memberName)}</option>`).join('')}</select>
    <button class="btn sm ghost" id="newGroup">+ Crear / unirse</button></div>`;
}
function bindSwitcher() {
  const s = document.getElementById('gsel');
  if (s) s.onchange = () => { store.setActive(s.value); viewGroups(); };
  const n = document.getElementById('newGroup');
  if (n) n.onclick = () => renderGroupForms();
}

function renderGroupForms(prefill = '') {
  $app.innerHTML = `
    ${prefill ? `<div class="card"><b>Te invitaron a una polla</b><div class="muted">Código ${esc(prefill)} — escribe tu nombre para entrar.</div></div>` : ''}
    <div class="grid2">
      <form class="card f" id="fJoin">
        <h3>Unirme a una polla</h3>
        <div><label>Código</label><input class="in" name="code" value="${esc(prefill)}" maxlength="8" required style="text-transform:uppercase"></div>
        <div><label>Tu nombre</label><input class="in" name="name" maxlength="30" required></div>
        <button class="btn">Unirme</button>
      </form>
      <form class="card f" id="fCreate">
        <h3>Crear una polla</h3>
        <div><label>Nombre de la polla</label><input class="in" name="group" maxlength="30" placeholder="Los del parche" required></div>
        <div><label>Tu nombre</label><input class="in" name="name" maxlength="30" required></div>
        <button class="btn">Crear</button>
      </form>
    </div>
    <form class="card f" id="fRestore">
      <details><summary>¿Ya estabas en una polla? Entra con tu llave personal</summary>
        <div class="f" style="margin-top:10px"><input class="in" name="token" placeholder="Llave de 48 caracteres"><button class="btn ghost">Entrar</button></div>
      </details>
    </form>
    <div class="card muted">Reglas: <b>${3}</b> puntos por marcador exacto · <b>1</b> punto por acertar ganador o empate. Las apuestas se cierran al pitazo inicial y las de los demás se ven cuando arranca el partido. Los penales no cuentan.</div>
    ${store.get().length ? '<div style="text-align:center"><a class="btn ghost" href="#grupos">← Volver a mis pollas</a></div>' : ''}`;

  const handle = (id, fn) => {
    const f = document.getElementById(id);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button:last-of-type');
      btn.disabled = true;
      try {
        const r = await fn(new FormData(f));
        store.add({ code: r.group.code, groupName: r.group.name, memberName: r.memberName, token: r.token, isAdmin: id === 'fCreate' || r.isAdmin, pts_exact: r.group.pts_exact, pts_winner: r.group.pts_winner });
        toast(`Listo, estás en «${r.group.name}»`);
        if (location.hash !== '#grupos') location.hash = 'grupos'; else viewGroups();
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    };
  };
  handle('fJoin', (fd) => post('/api/groups', { action: 'join', code: fd.get('code'), memberName: fd.get('name') }));
  handle('fCreate', (fd) => post('/api/groups', { action: 'create', groupName: fd.get('group'), memberName: fd.get('name') }));
  handle('fRestore', (fd) => post('/api/groups', { action: 'restore', token: String(fd.get('token') || '').trim() }));
}

route();
