import { ESPN, espn, sb, send, fail, readBody, query, httpErr, groupByCode, eventResult, enc } from './_lib.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return await list(req, res);
    if (req.method === 'POST') return await place(req, res);
    throw httpErr(405, 'Método no permitido');
  } catch (e) {
    fail(res, e);
  }
}

// GET /api/bets?code=ABC123&token=...&event=123
// Las apuestas de otros se ocultan hasta que empieza el partido.
async function list(req, res) {
  const { code, token, event } = query(req);
  const g = await groupByCode(code);
  let meId = null;
  if (token) {
    const me = await sb(`members?token=eq.${enc(token)}&group_id=eq.${g.id}&select=id`);
    meId = me?.[0]?.id || null;
  }
  let path = `bets?group_id=eq.${g.id}&select=event_id,home_goals,away_goals,kickoff,home_team,away_team,member_id,members(name)&order=kickoff.desc`;
  if (event && /^\d+$/.test(event)) path += `&event_id=eq.${event}`;
  const rows = await sb(path);
  const now = Date.now();
  const bets = rows.map((r) => {
    const mine = r.member_id === meId;
    const hidden = !mine && now < Date.parse(r.kickoff);
    return {
      eventId: r.event_id, kickoff: r.kickoff, homeTeam: r.home_team, awayTeam: r.away_team,
      name: r.members?.name, mine, hidden,
      home: hidden ? null : r.home_goals, away: hidden ? null : r.away_goals,
    };
  });
  send(res, 200, { bets });
}

// POST { tokens:[...], eventId, home, away }  → guarda la apuesta en todos los grupos del usuario
async function place(req, res) {
  const b = await readBody(req);
  const eventId = String(b.eventId || '');
  if (!/^\d+$/.test(eventId)) throw httpErr(400, 'Partido inválido');
  const home = Number(b.home), away = Number(b.away);
  if (![home, away].every((n) => Number.isInteger(n) && n >= 0 && n <= 20)) throw httpErr(400, 'Marcador inválido (0–20)');
  const tokens = (Array.isArray(b.tokens) ? b.tokens : [b.token]).filter((t) => /^[a-f0-9]{48}$/.test(t || '')).slice(0, 20);
  if (!tokens.length) throw httpErr(401, 'Únete a un grupo antes de apostar');

  // La hora de inicio se valida contra ESPN en el servidor: no se puede apostar con el partido empezado.
  const data = await espn(`${ESPN}/summary?event=${eventId}`);
  const r = eventResult(data?.header?.competitions?.[0]);
  if (!r.date) throw httpErr(404, 'Partido no encontrado');
  if (r.state !== 'pre' || Date.now() >= Date.parse(r.date)) throw httpErr(403, 'Apuestas cerradas: el partido ya empezó');

  const members = await sb(`members?token=in.(${tokens.join(',')})&select=id,group_id`);
  if (!members.length) throw httpErr(401, 'Llave no válida');
  const rows = members.map((m) => ({
    member_id: m.id, group_id: m.group_id, event_id: eventId,
    home_goals: home, away_goals: away, kickoff: r.date,
    home_team: r.homeTeam, away_team: r.awayTeam, updated_at: new Date().toISOString(),
  }));
  await sb('bets?on_conflict=member_id,event_id', { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });
  send(res, 200, { ok: true, groups: rows.length });
}
