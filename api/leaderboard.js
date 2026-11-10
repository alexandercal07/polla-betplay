import { scoreboardRange, sb, send, fail, query, groupByCode, eventResult, scoreBet, ymd } from './_lib.js';

// GET /api/leaderboard?code=ABC123
export default async function handler(req, res) {
  try {
    const g = await groupByCode(query(req).code);
    const [members, bets] = await Promise.all([
      sb(`members?group_id=eq.${g.id}&select=id,name&order=created_at`),
      sb(`bets?group_id=eq.${g.id}&select=member_id,event_id,home_goals,away_goals,kickoff,home_team,away_team`),
    ]);
    const since = g.since ? Date.parse(g.since + 'T00:00:00-05:00') : 0;
    const counted = bets.filter((b) => Date.parse(b.kickoff) >= since);

    // Resultados: una sola llamada al scoreboard que cubre el rango de fechas de las apuestas
    const results = {};
    if (counted.length) {
      const times = counted.map((b) => Date.parse(b.kickoff));
      const from = ymd(new Date(Math.min(...times) - 864e5));
      const to = ymd(new Date(Math.max(...times) + 864e5));
      const sbd = await scoreboardRange(from, to);
      for (const ev of sbd.events || []) results[ev.id] = eventResult(ev.competitions?.[0]);
    }

    const cfg = { exact: g.pts_exact, winner: g.pts_winner };
    const rows = members.map((m) => ({ id: m.id, name: m.name, pts: 0, exact: 0, winner: 0, miss: 0, pending: 0 }));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const history = [];
    for (const b of counted) {
      const row = byId[b.member_id];
      if (!row) continue;
      const res = results[b.event_id];
      if (res?.state === 'void') continue; // aplazado/cancelado: no cuenta
      const s = scoreBet(b, res, cfg);
      if (!s) { row.pending++; continue; }
      row.pts += s.pts;
      row[s.kind]++;
      history.push({ name: row.name, eventId: b.event_id, kickoff: b.kickoff, homeTeam: b.home_team, awayTeam: b.away_team,
        bet: [b.home_goals, b.away_goals], result: [res.home, res.away], pts: s.pts, kind: s.kind });
    }
    rows.sort((a, b) => b.pts - a.pts || b.exact - a.exact || b.winner - a.winner || a.name.localeCompare(b.name));
    history.sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff));
    send(res, 200, { group: { code: g.code, name: g.name, pts_exact: g.pts_exact, pts_winner: g.pts_winner, since: g.since }, rows, history: history.slice(0, 200) }, 's-maxage=15');
  } catch (e) {
    fail(res, e);
  }
}
