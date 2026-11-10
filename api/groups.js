import { sb, send, fail, readBody, query, httpErr, cleanName, cleanCode, newCode, newToken, groupByCode, enc } from './_lib.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { code } = query(req);
      const g = await groupByCode(code);
      const members = await sb(`members?group_id=eq.${g.id}&select=id,name,is_admin&order=created_at`);
      return send(res, 200, { group: pub(g), members });
    }
    if (req.method !== 'POST') throw httpErr(405, 'Método no permitido');

    const b = await readBody(req);

    if (b.action === 'create') {
      const groupName = cleanName(b.groupName), memberName = cleanName(b.memberName);
      if (!groupName || !memberName) throw httpErr(400, 'Nombre del grupo y tu nombre son obligatorios');
      let g;
      for (let i = 0; i < 5 && !g; i++) {
        try {
          [g] = await sb('groups', { method: 'POST', body: { code: newCode(), name: groupName }, prefer: 'return=representation' });
        } catch (e) { if (e.code !== '23505') throw e; }
      }
      if (!g) throw httpErr(500, 'No se pudo generar un código');
      const token = newToken();
      await sb('members', { method: 'POST', body: { group_id: g.id, name: memberName, token, is_admin: true } });
      return send(res, 200, { group: pub(g), token, memberName });
    }

    if (b.action === 'join') {
      const g = await groupByCode(b.code);
      const memberName = cleanName(b.memberName);
      if (!memberName) throw httpErr(400, 'Escribe tu nombre');
      const token = newToken();
      try {
        await sb('members', { method: 'POST', body: { group_id: g.id, name: memberName, token } });
      } catch (e) {
        if (e.code === '23505') throw httpErr(409, 'Ese nombre ya está en uso en el grupo. Si eres tú, entra con tu llave personal.');
        throw e;
      }
      return send(res, 200, { group: pub(g), token, memberName });
    }

    if (b.action === 'restore') {
      const token = String(b.token || '').trim();
      if (!/^[a-f0-9]{48}$/.test(token)) throw httpErr(400, 'Llave inválida');
      const rows = await sb(`members?token=eq.${token}&select=name,is_admin,groups(*)`);
      if (!rows?.length) throw httpErr(404, 'Llave no encontrada');
      return send(res, 200, { group: pub(rows[0].groups), token, memberName: rows[0].name, isAdmin: rows[0].is_admin });
    }

    if (b.action === 'update') {
      const g = await groupByCode(b.code);
      const me = await sb(`members?token=eq.${enc(String(b.token || ''))}&group_id=eq.${g.id}&select=is_admin`);
      if (!me?.[0]?.is_admin) throw httpErr(403, 'Solo quien creó el grupo puede configurarlo');
      const patch = {};
      if (b.name !== undefined) patch.name = cleanName(b.name) || g.name;
      if (b.ptsExact !== undefined) patch.pts_exact = clampInt(b.ptsExact, 0, 20);
      if (b.ptsWinner !== undefined) patch.pts_winner = clampInt(b.ptsWinner, 0, 20);
      if (b.since !== undefined) patch.since = /^\d{4}-\d{2}-\d{2}$/.test(b.since || '') ? b.since : null;
      const [ng] = await sb(`groups?id=eq.${g.id}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
      return send(res, 200, { group: pub(ng) });
    }

    throw httpErr(400, 'Acción desconocida');
  } catch (e) {
    fail(res, e);
  }
}

const pub = (g) => ({ code: g.code, name: g.name, pts_exact: g.pts_exact, pts_winner: g.pts_winner, since: g.since });
function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw httpErr(400, 'Puntaje inválido');
  return Math.min(hi, Math.max(lo, n));
}
