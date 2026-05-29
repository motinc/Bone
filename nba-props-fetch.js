#!/usr/bin/env node
/* =====================================================================
   NBA-PROPS-FETCH — build tonight's points-prop edges
   Pipeline:
     1. scoreboard → tonight's games + which teams play (for opponent map)
     2. propBets (all pages) → tonight's points-prop lines (over/under pairs)
     3. for each player with a points prop → resolve name, fetch gamelog
     4. project points (nba-props-model) w/ opponent-defense from team ratings
     5. compute edge vs the book line → write data/nba-props.json

   Run:  node nba-props-fetch.js
   Needs data/nba-ratings.json (team model, for opponent defense). Optional —
   falls back to no defense adjustment if missing.

   Heavy on API calls (one gamelog per player). Throttled. ESPN public API.
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const M = require('./nba-props-model.js');

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const WEB  = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba';
const CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba';
const SEASON = new Date().getFullYear();
const THROTTLE_MS = 250;
const POINTS_PROP = 'Total Points';   // type.name we model in v1
const OUT_DIR = path.join(process.cwd(), 'data');
const OUT_FILE = path.join(OUT_DIR, 'nba-props.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url) {
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0,80)}`);
  return r.json();
}
const refId = (ref, kind) => { const m = ref && ref.match(new RegExp(kind + '/(\\d+)')); return m ? m[1] : null; };

(async () => {
  console.log('NBA-PROPS-FETCH — tonight\'s points-prop edges\n');

  // team ratings (for opponent defense). optional.
  let teamRatings = null;
  const ratingsFile = path.join(OUT_DIR, 'nba-ratings.json');
  if (fs.existsSync(ratingsFile)) {
    teamRatings = JSON.parse(fs.readFileSync(ratingsFile, 'utf8'));
    console.log(`Loaded team ratings (${Object.keys(teamRatings.teams).length} teams) for opponent-defense adj.`);
  } else {
    console.log('No nba-ratings.json — proceeding without opponent-defense adjustment.');
  }

  // ── INJURY MAP ── pull league injuries so we never recommend a prop on a
  // player who is OUT, and flag the questionable ones. ESPN's injury feed gives
  // the player NAME (not id) and a clean type.description ("out","day-to-day",
  // "questionable",...), so we key by displayName and match props by name.
  const injuryMap = new Map();   // displayName → status description
  try {
    const inj = await getJson(`${SITE}/injuries`);
    const groups = inj.injuries || [];
    for (const g of groups) {
      for (const it of (g.injuries || [])) {
        const name = it.athlete && it.athlete.displayName;
        // prefer the structured type.description; fall back to the status string
        const status = (it.type && it.type.description) || it.status || 'unknown';
        if (name) injuryMap.set(name, status);
      }
    }
    console.log(`Injury map: ${injuryMap.size} players with a status.`);
  } catch (e) {
    console.log(`(injuries endpoint unavailable: ${e.message} — proceeding without injury filter)`);
  }
  // classify a status string into a betting decision
  const injuryClass = (s) => {
    if (!s) return 'ok';
    const t = String(s).toLowerCase();
    if (/out|inactive|suspend|not with team/.test(t)) return 'out';
    if (/doubtful/.test(t)) return 'doubtful';
    if (/question|day-to-day|day to day|game time|probable/.test(t)) return 'questionable';
    return 'ok';
  };

  // 1) scoreboard → games today + team→opponent map
  const sb = await getJson(`${SITE}/scoreboard`);
  const events = sb.events || [];
  console.log(`Scoreboard: ${events.length} games today.`);
  if (!events.length) { console.log('No games today — nothing to do.'); return; }

  // map: teamId → { oppId, eventId }
  const teamOpp = new Map();
  const eventIds = [];
  for (const ev of events) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) continue;
    const cs = comp.competitors || [];
    if (cs.length < 2) continue;
    const t1 = cs[0].team.id, t2 = cs[1].team.id;
    teamOpp.set(t1, { oppId: t2, eventId: ev.id });
    teamOpp.set(t2, { oppId: t1, eventId: ev.id });
    eventIds.push({ eventId: ev.id, compId: comp.id });
  }

  // 2) prop lines — all pages, points only. Pair over/under by adjacency.
  const props = [];   // { athleteId, line, overOdds, underOdds, eventId, openLine }
  for (const { eventId, compId } of eventIds) {
    let page = 1, pageCount = 1;
    do {
      let data;
      try { data = await getJson(`${CORE}/events/${eventId}/competitions/${compId}/odds/100/propBets?page=${page}`); }
      catch (e) { console.log(`  props ${eventId} p${page}: ${e.message}`); break; }
      pageCount = data.pageCount || 1;
      const items = (data.items || []).filter(it => it.type && it.type.name === POINTS_PROP);
      // pair consecutive same-athlete same-line items as [over, under]
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const athleteId = refId(it.athlete && it.athlete['$ref'], 'athletes');
        const line = it.current && it.current.target ? it.current.target.value : null;
        const dec = it.odds && it.odds.decimal ? parseFloat(it.odds.decimal.value) : null;
        if (!athleteId || line == null || !dec) continue;
        // find or create the pair for this athlete+line
        let pair = props.find(p => p.athleteId === athleteId && p.line === line && p.eventId === eventId && p.underOdds == null);
        if (!pair) {
          props.push({ athleteId, line, overOdds: dec, underOdds: null, eventId,
                       openLine: it.open && it.open.target ? it.open.target.value : line });
        } else {
          pair.underOdds = dec;   // second of the pair = under
        }
      }
      page++;
      await sleep(THROTTLE_MS);
    } while (page <= pageCount);
  }
  console.log(`Found ${props.length} points-prop lines.`);
  if (!props.length) { console.log('No points props posted yet (try closer to tip-off).'); return; }

  // 3+4) per unique player: resolve name + team, fetch gamelog, project
  const uniquePlayers = [...new Set(props.map(p => p.athleteId))];
  console.log(`Resolving + projecting ${uniquePlayers.length} players...`);
  const playerCache = new Map();   // athleteId → { name, teamId, projection }

  for (const athleteId of uniquePlayers) {
    try {
      // gamelog: stat lines + per-game opponent/team context
      const gl = await getJson(`${WEB}/athletes/${athleteId}/gamelog?season=${SEASON}`);
      // name isn't in the gamelog — resolve from the core athlete endpoint
      let name = `#${athleteId}`;
      try {
        const ath = await getJson(`${CORE}/seasons/${SEASON}/athletes/${athleteId}`);
        name = ath.displayName || ath.fullName || ath.shortName || name;
        await sleep(THROTTLE_MS);
      } catch (e) { /* keep fallback name */ }

      // pull regular-season stat lines, oldest→newest
      let raw = [];
      const types = gl.seasonTypes || [];
      const st = types.find(s => /Regular/i.test(s.displayName)) || types[0];
      if (st) for (const cat of (st.categories || [])) if (cat.events) for (const e of cat.events) raw.push(e.stats);
      raw = raw.reverse();
      const games = M.parseGameLog(raw);

      // player's current team: from their most recent gamelog event
      let teamId = null;
      const evObj = gl.events || {};
      const evKeys = Object.keys(evObj);
      if (evKeys.length) {
        // events object isn't ordered; pick the one with the latest gameDate
        let latest = null;
        for (const k of evKeys) {
          const e = evObj[k];
          if (e && e.gameDate && (!latest || e.gameDate > latest.gameDate)) latest = e;
        }
        if (latest && latest.team) teamId = latest.team.id;
      }

      // opponent defense from team ratings
      let oppDef = 0, oppName = null;
      if (teamId && teamOpp.has(teamId) && teamRatings) {
        const oppId = teamOpp.get(teamId).oppId;
        const opp = teamRatings.teams[oppId];
        if (opp) { oppDef = opp.def; oppName = opp.name; }
      }

      const projection = games.length >= 5 ? M.projectPoints({ games, oppDefRating: oppDef, halfLife: 12 }) : null;
      playerCache.set(athleteId, { name, teamId, oppDef, oppName, projection, gameCount: games.length });
    } catch (e) {
      playerCache.set(athleteId, { name: `#${athleteId}`, projection: null, error: e.message });
    }
    await sleep(THROTTLE_MS);
  }

  // 5) compute edges — with a STARTER FILTER and edge sanity cap.
  // Low-line bench players are inherently unpredictable (minutes bounce,
  // playoff DNPs), and the model's edges on them are noise. We keep only
  // stable, high-minute players on meaningful lines, and cap displayed edges.
  const MIN_LINE = 10;       // skip props with a line under 10 pts (bench noise)
  const MIN_PROJ_MIN = 25;   // skip players projected under 25 min (not a starter)
  const MIN_GAMES = 20;      // need a real sample
  const EDGE_CAP = 25;       // edges above this are almost always stale/resting

  const edges = [];
  let filtered = 0, injuryFiltered = 0;
  for (const p of props) {
    const pl = playerCache.get(p.athleteId);
    if (!pl || !pl.projection) continue;
    const pr = pl.projection;
    // injury gate: never recommend a prop on a player who is OUT/doubtful.
    // Matched by name (the injury feed has no athlete id).
    const injStatus = injuryMap.get(pl.name);
    const injCls = injuryClass(injStatus);
    if (injCls === 'out' || injCls === 'doubtful') { injuryFiltered++; continue; }
    // starter filter
    if (p.line < MIN_LINE || pr.recentMin < MIN_PROJ_MIN || pr.n < MIN_GAMES) { filtered++; continue; }
    const e = M.propEdge(pr, p.line, p.overOdds, p.underOdds);
    // sanity cap: drop implausible edges (stale line / player likely out)
    const bestEdge = Math.max(e.edgeOver ?? -99, e.edgeUnder ?? -99);
    const capped = bestEdge > EDGE_CAP;
    // which side does the model favour? (for line-movement interpretation)
    const modelSide = (e.edgeOver ?? -99) >= (e.edgeUnder ?? -99) ? 'OVER' : 'UNDER';
    const move = M.lineMovement(p.openLine, p.line, modelSide);
    edges.push({
      player: pl.name,
      oppName: pl.oppName || null,
      line: p.line,
      proj: +pr.proj.toFixed(1),
      sd: +pr.sd.toFixed(1),
      projMin: +pr.recentMin.toFixed(1),
      minStability: pr.minStability,
      pOver: +(e.pOver*100).toFixed(1),
      overOdds: p.overOdds, underOdds: p.underOdds,
      edgeOver: e.edgeOver != null ? +e.edgeOver.toFixed(1) : null,
      edgeUnder: e.edgeUnder != null ? +e.edgeUnder.toFixed(1) : null,
      openLine: p.openLine,
      lineMove: move.delta,        // + = line rose since open
      lineMoveDir: move.dir,       // 'with' | 'against' | 'flat' | 'unknown'
      gameCount: pr.n,
      injury: injCls !== 'ok' ? injStatus : null,
      flag: capped ? 'edge>cap — verify (stale line / rest?)' : (injCls === 'questionable' ? `${injStatus} — confirm active` : null),
    });
  }
  // sort by best available edge, capped ones sink (they're suspect)
  const bestOf = e => { const m = Math.max(e.edgeOver??-99, e.edgeUnder??-99); return e.flag ? m - 1000 : m; };
  edges.sort((a,b) => bestOf(b) - bestOf(a));
  console.log(`Filtered out ${filtered} bench/low-line props${injuryFiltered?` + ${injuryFiltered} injured (OUT/doubtful)`:''} (kept ${edges.length} starter props).`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generated: new Date().toISOString(), count: edges.length, edges }, null, 2));
  console.log(`\nWrote ${OUT_FILE}: ${edges.length} prop edges.`);
  console.log('\nTop 10 by edge (starters only):');
  edges.slice(0, 10).forEach(e => {
    const side = (e.edgeOver||-99) > (e.edgeUnder||-99) ? `OVER ${e.line} (+${e.edgeOver}%)` : `UNDER ${e.line} (+${e.edgeUnder}%)`;
    const mv = e.lineMoveDir === 'with' ? ' ↗with-market' : (e.lineMoveDir === 'against' ? ' ↘vs-market' : '');
    const flag = e.flag ? `  ⚠ ${e.flag}` : '';
    console.log(`  ${e.player.padEnd(24)} proj ${e.proj} (${e.projMin}min) vs line ${e.line} → ${side}${mv}  [${e.gameCount}g]${flag}`);
  });
  console.log('\nLine-movement: "with-market" = line moved toward your pick (confirmation, edge may be');
  console.log('  fading). "vs-market" = line moved away (you found something, OR you\'re missing news).');
  console.log('⚠ Props are the hardest market to beat. Regular-season projections — playoff rotations differ.');
})();
