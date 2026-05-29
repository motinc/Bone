#!/usr/bin/env node
/* =====================================================================
   NBA-SEED-TEAMS — backfill team game results from ESPN scoreboard
   Walks the scoreboard backwards day-by-day, collecting final scores.
   Output: data/nba-games.json — the training corpus for the team model
   (offensive/defensive ratings, pace, home court, rest).

   Run locally:  node nba-seed-teams.js
   Then commit data/nba-games.json. The live pipeline appends new finals.

   Resumable + throttled. ESPN public API, no key.
   ===================================================================== */

const fs = require('fs');
const path = require('path');

const DAYS_BACK = 220;        // ~ a full NBA regular season + a bit
const THROTTLE_MS = 300;      // gentle on ESPN
const OUT_DIR = path.join(__dirname, 'data');
const OUT_FILE = path.join(OUT_DIR, 'nba-games.json');
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;

async function fetchDay(dateStr) {
  const url = `${SITE}/scoreboard?dates=${dateStr}`;
  const r = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${dateStr}`);
  const d = await r.json();
  return d.events || [];
}

// compact a scoreboard event into a game result; null to skip (not final)
function compact(ev) {
  const comp = ev.competitions && ev.competitions[0];
  if (!comp) return null;
  const status = comp.status && comp.status.type ? comp.status.type.name : '';
  if (status !== 'STATUS_FINAL') return null;     // only completed games
  const cs = comp.competitors || [];
  if (cs.length < 2) return null;
  const home = cs.find(c => c.homeAway === 'home');
  const away = cs.find(c => c.homeAway === 'away');
  if (!home || !away || home.score == null || away.score == null) return null;
  const hs = parseInt(home.score, 10), as = parseInt(away.score, 10);
  if (isNaN(hs) || isNaN(as)) return null;
  return {
    id: ev.id,
    date: ev.date,
    homeId: home.team.id, homeName: home.team.abbreviation || home.team.displayName,
    awayId: away.team.id, awayName: away.team.abbreviation || away.team.displayName,
    homeScore: hs, awayScore: as,
    homeWin: hs > as,
    // OT/regulation could be added later; not needed for v1 ratings
  };
}

(async () => {
  console.log('NBA-SEED-TEAMS — backfilling team game results');
  console.log(`Walking back ${DAYS_BACK} days from today.`);

  const byId = new Map();
  if (fs.existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      (prev.games || []).forEach(g => byId.set(g.id, g));
      console.log(`Resuming — ${byId.size} games already saved.`);
    } catch (e) {}
  }

  let scanned = 0, kept = 0, emptyDays = 0;
  const today = new Date();
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date(today.getTime() - i*24*3600*1000);
    const ds = ymd(d);
    let events;
    try { events = await fetchDay(ds); }
    catch (e) { console.log(`\n⚠ ${e.message} — stopping, progress saved. Re-run to resume.`); break; }

    let dayKept = 0;
    for (const ev of events) {
      scanned++;
      const g = compact(ev);
      if (g) { byId.set(g.id, g); dayKept++; kept++; }
    }
    if (events.length === 0) emptyDays++; else emptyDays = 0;
    process.stdout.write(`\r${ds}: ${events.length} games · total kept ${byId.size}   `);
    if (i % 10 === 0) writeOut(byId);
    // if we hit a long run of empty days, we've walked past the season
    if (emptyDays >= 21) { console.log(`\n(21 empty days in a row — reached off-season, stopping.)`); break; }
    await sleep(THROTTLE_MS);
  }

  writeOut(byId);
  console.log(`\n\nDONE. Scanned ${scanned} events, kept ${byId.size} final games.`);
  console.log(`Saved to ${OUT_FILE}`);
  console.log('Next: nba-model-teams.js trains ratings on this.');
})();

function writeOut(byId) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const games = [...byId.values()].sort((a,b) => (a.date||'').localeCompare(b.date||''));
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    generated: new Date().toISOString(),
    daysBack: DAYS_BACK,
    count: games.length,
    games,
  }));
}
