#!/usr/bin/env node
/* =====================================================================
   BONE — odds fetcher
   Pulls today's tennis h2h odds from The Odds API using a SECRET key
   (passed via the ODDS_API_KEY environment variable / GitHub Secret),
   and writes a compact data/odds.json the dashboard loads.

   The key NEVER appears in the committed output — only the odds do.
   ===================================================================== */

const fs = require('fs');
const path = require('path');

const KEY = process.env.ODDS_API_KEY;
const HOST = 'https://api.the-odds-api.com';
const MARKET = 'h2h';
const SET_MARKET = 'spreads';            // tennis set handicap (-1.5/+1.5 sets)
const MARKETS = `${MARKET},${SET_MARKET}`; // The Odds API bills per-market, so
                                           // this ~doubles credit use vs h2h only.
const OUT_DIR = path.join(__dirname, '..', 'data');

// Which books to fetch. Mirrors the browser registry. Up to 10 books = 1 request.
const BOOKMAKERS = ['sportsbet','ladbrokes_au','tab','neds','unibet','betfair_ex_au','pinnacle'];

const normName = s => !s ? '' : s.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-zA-Z\s\-']/g,'').trim().toLowerCase().replace(/\s+/g,' ');
const surnameKey = name => {
  const n=normName(name); if(!n) return '';
  const p=n.split(' ').filter(Boolean); return p.length?p[p.length-1]:n;
};

(async()=>{
  console.log('BONE odds fetcher');
  if(!KEY){
    console.error('No ODDS_API_KEY set — writing empty odds file (no fake data).');
    writeOut('odds.json', { generated:new Date().toISOString(), error:'no_key', matches:{} });
    return;
  }

  // Step 1: in-season tennis comps
  let tennisKeys=[];
  try{
    const r=await fetch(`${HOST}/v4/sports/?apiKey=${KEY}`);
    if(!r.ok){ console.error(`sports endpoint: ${r.status}`); writeOut('odds.json',{generated:new Date().toISOString(),error:`sports_${r.status}`,matches:{}}); return; }
    const sports=await r.json();
    tennisKeys=sports.filter(s=>s.key.startsWith('tennis_')&&s.active).map(s=>s.key);
    console.log(`  active tennis comps: ${tennisKeys.length}`);
  }catch(e){ console.error('sports err:',e.message); writeOut('odds.json',{generated:new Date().toISOString(),error:'network',matches:{}}); return; }

  if(tennisKeys.length===0){
    console.log('  no tennis in season');
    writeOut('odds.json', { generated:new Date().toISOString(), matches:{}, note:'no_tennis_in_season' });
    return;
  }

  // Step 2: odds per comp, filtered to our books. Fetch h2h + set handicaps.
  const bookParam=BOOKMAKERS.join(',');
  const matches={};
  let remaining=null;
  for(const key of tennisKeys){
    try{
      const url=`${HOST}/v4/sports/${key}/odds?bookmakers=${bookParam}&markets=${MARKETS}&oddsFormat=decimal&apiKey=${KEY}`;
      const r=await fetch(url);
      remaining=r.headers.get('x-requests-remaining');
      if(!r.ok){ console.log(`  odds ${key}: ${r.status}`); continue; }
      const events=await r.json();
      for(const ev of events){
        const k1=surnameKey(ev.home_team), k2=surnameKey(ev.away_team);
        const byBook={};       // bookTitle -> { [surnameKey]: h2h price }
        const byBookSet={};    // bookTitle -> { [surnameKey]: { point, price } }
        for(const bk of (ev.bookmakers||[])){
          const h2h=(bk.markets||[]).find(m=>m.key==='h2h');
          if(h2h){
            byBook[bk.title]={};
            for(const oc of (h2h.outcomes||[])) byBook[bk.title][surnameKey(oc.name)]=oc.price;
          }
          // Set handicap: each outcome carries a signed `point` (-1.5 / +1.5).
          const sp=(bk.markets||[]).find(m=>m.key==='spreads');
          if(sp){
            byBookSet[bk.title]={};
            for(const oc of (sp.outcomes||[])) byBookSet[bk.title][surnameKey(oc.name)]={ point:oc.point, price:oc.price };
          }
        }
        if(Object.keys(byBook).length || Object.keys(byBookSet).length){
          const pairKey=[k1,k2].sort().join('|');
          matches[pairKey]={ k1,k2, home:ev.home_team, away:ev.away_team, commence:ev.commence_time, byBook, byBookSet };
        }
      }
      console.log(`  odds ${key}: ${events.length} events`);
    }catch(e){ console.log(`  odds ${key} err: ${e.message}`); }
  }

  console.log(`  matched ${Object.keys(matches).length} markets (h2h + sets) · ${remaining||'?'} reqs left`);
  writeOut('odds.json', { generated:new Date().toISOString(), reqsRemaining:remaining, books:BOOKMAKERS, matches });

  // ── Closing-line capture ──
  // Accumulate the last odds we see before each match starts. A match that has
  // started (or starts within 30 min) and isn't already recorded gets its
  // current odds frozen as the "closing line" for CLV measurement.
  let closing = {};
  try { closing = JSON.parse(fs.readFileSync(path.join(OUT_DIR,'closing.json'),'utf8')).matches || {}; } catch(e) {}
  const now = Date.now();
  let captured = 0;
  for (const [pairKey, m] of Object.entries(matches)) {
    if (closing[pairKey]) continue;                 // already have a closing line
    const start = m.commence ? Date.parse(m.commence) : null;
    if (!start) continue;
    // freeze odds once we're within 30 min of start or past it
    if (start - now <= 30*60*1000) {
      // best price per player across books = the closing line we'd have gotten
      const best = {};
      for (const prices of Object.values(m.byBook)) {
        for (const [pk, price] of Object.entries(prices)) {
          if (!best[pk] || price > best[pk]) best[pk] = price;
        }
      }
      closing[pairKey] = { k1:m.k1, k2:m.k2, home:m.home, away:m.away, commence:m.commence, best, capturedAt:new Date().toISOString() };
      captured++;
    }
  }
  // prune closing lines older than 14 days to keep the file small
  const cutoff = now - 14*24*60*60*1000;
  for (const [k,v] of Object.entries(closing)) {
    const start = v.commence ? Date.parse(v.commence) : 0;
    if (start && start < cutoff) delete closing[k];
  }
  console.log(`  closing lines: +${captured} captured, ${Object.keys(closing).length} stored`);
  writeOut('closing.json', { generated:new Date().toISOString(), matches:closing });
})();

function writeOut(name, obj){
  if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR,{recursive:true});
  const file=path.join(OUT_DIR,name);
  fs.writeFileSync(file, JSON.stringify(obj));
  console.log(`Wrote ${file}`);
}
