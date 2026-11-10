import crypto from 'node:crypto';

export const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/col.1';
export const ESPN_STANDINGS = 'https://site.api.espn.com/apis/v2/sports/soccer/col.1/standings';

export async function sb(path, { method = 'GET', body, prefer } = {}) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw httpErr(500, 'Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      // Llaves nuevas (sb_secret_…) van solo en apikey; las legacy (JWT eyJ…) también como Bearer
      apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  const data = t ? JSON.parse(t) : null;
  if (!r.ok) {
    const e = httpErr(r.status >= 500 ? 502 : 400, data?.message || r.statusText);
    e.code = data?.code;
    throw e;
  }
  return data;
}

export async function espn(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw httpErr(502, `ESPN respondió ${r.status}`);
  return r.json();
}

const toDate = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const toYmd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * Partidos entre dos fechas (YYYYMMDD). ESPN no siempre acepta rangos largos para col.1,
 * así que prueba: rango completo → bloques de 7 días → día por día. Une y quita duplicados.
 */
export async function scoreboardRange(from, to) {
  const days = [];
  for (let d = toDate(from); d <= toDate(to); d = new Date(d.getTime() + 864e5)) days.push(toYmd(d));
  if (!days.length) return { events: [] };
  const one = (q) => espn(`${ESPN}/scoreboard?dates=${q}`);
  const merge = (list) => {
    const seen = new Map();
    for (const r of list) for (const ev of r?.events || []) seen.set(ev.id, ev);
    return { events: [...seen.values()] };
  };
  if (days.length === 1) return merge([await one(days[0])]);
  try { return merge([await one(`${from}-${to}`)]); } catch {}
  const chunk = async (size) => {
    const qs = [];
    for (let i = 0; i < days.length; i += size) {
      const a = days[i], b = days[Math.min(i + size, days.length) - 1];
      qs.push(a === b ? a : `${a}-${b}`);
    }
    const out = [];
    for (let i = 0; i < qs.length; i += 10) out.push(...await Promise.all(qs.slice(i, i + 10).map(one)));
    return merge(out);
  };
  try { return await chunk(7); } catch {}
  return chunk(1);
}

export function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function send(res, status, data, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(data));
}

export function fail(res, e) {
  send(res, e.status || 500, { error: e.message || 'Error' });
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

export function query(req) {
  if (req.query) return req.query;
  return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
}

export const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 30);
export const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
export const enc = encodeURIComponent;

export function newCode(len = 6) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += A[crypto.randomInt(A.length)];
  return s;
}
export const newToken = () => crypto.randomBytes(24).toString('hex');

export async function groupByCode(code) {
  const c = cleanCode(code);
  if (!c) throw httpErr(400, 'Código de grupo inválido');
  const rows = await sb(`groups?code=eq.${enc(c)}&select=*`);
  if (!rows?.length) throw httpErr(404, 'Grupo no encontrado');
  return rows[0];
}

/** Puntos de una apuesta. result = {state, home, away}. null = aún no se juega/termina. */
export function scoreBet(bet, result, cfg) {
  if (!result || result.state !== 'post') return null;
  const bh = bet.home_goals, ba = bet.away_goals, rh = result.home, ra = result.away;
  if (bh === rh && ba === ra) return { pts: cfg.exact, kind: 'exact' };
  if (Math.sign(bh - ba) === Math.sign(rh - ra)) return { pts: cfg.winner, kind: 'winner' };
  return { pts: 0, kind: 'miss' };
}

/** Resume un evento de ESPN (scoreboard o header de summary). */
export function eventResult(comp) {
  const st = comp?.status?.type || {};
  const cs = comp?.competitors || [];
  const h = cs.find((c) => c.homeAway === 'home') || cs[0];
  const a = cs.find((c) => c.homeAway === 'away') || cs[1];
  const canceled = /POSTPONED|CANCELED|CANCELLED|SUSPENDED|ABANDONED/.test(st.name || '');
  return {
    state: canceled ? 'void' : st.state,
    completed: !!st.completed,
    date: comp?.date,
    home: Number(h?.score?.value ?? h?.score ?? 0),
    away: Number(a?.score?.value ?? a?.score ?? 0),
    homeTeam: h?.team?.displayName,
    awayTeam: a?.team?.displayName,
  };
}

/** YYYYMMDD en hora de Bogotá */
export function ymd(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p.replace(/-/g, '');
}
