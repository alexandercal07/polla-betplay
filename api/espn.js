// Proxy con caché hacia la API pública (no oficial) de ESPN para la Liga BetPlay (col.1).
// El caché en el CDN de Vercel hace que muchos amigos conectados = pocas llamadas a ESPN.
import { ESPN, ESPN_STANDINGS, espn, send, fail, query, httpErr } from './_lib.js';

export default async function handler(req, res) {
  try {
    const { kind, dates, event } = query(req);
    let url, cache;
    if (kind === 'scoreboard') {
      if (!/^\d{8}(-\d{8})?$/.test(dates || '')) throw httpErr(400, 'dates debe ser YYYYMMDD o YYYYMMDD-YYYYMMDD');
      url = `${ESPN}/scoreboard?dates=${dates}&limit=500`;
      cache = 's-maxage=20, stale-while-revalidate=40';
    } else if (kind === 'summary') {
      if (!/^\d+$/.test(event || '')) throw httpErr(400, 'event inválido');
      url = `${ESPN}/summary?event=${event}`;
      cache = 's-maxage=15, stale-while-revalidate=30';
    } else if (kind === 'standings') {
      url = ESPN_STANDINGS;
      cache = 's-maxage=120, stale-while-revalidate=300';
    } else {
      throw httpErr(400, 'kind debe ser scoreboard | summary | standings');
    }
    send(res, 200, await espn(url), cache);
  } catch (e) {
    fail(res, e);
  }
}
