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
    writeOut({ generated:new Date().toISOString(), error:'no_key', matches:{} });
    return;
  }

  // Step 1: in-season tennis comps
  let tennisKeys=[];
  try{
    const r=await fetch(`${HOST}/v4/sports/?apiKey=${KEY}`);
    if(!r.ok){ console.error(`sports endpoint: ${r.status}`); writeOut({generated:new Date().toISOString(),error:`sports_${r.status}`,matches:{}}); return; }
    const sports=await r.json();
    tennisKeys=sports.filter(s=>s.key.startsWith('tennis_')&&s.active).map(s=>s.key);
    console.log(`  active tennis comps: ${tennisKeys.length}`);
  }catch(e){ console.error('sports err:',e.message); writeOut({generated:new Date().toISOString(),error:'network',matches:{}}); return; }

  if(tennisKeys.length===0){
    console.log('  no tennis in season');
    writeOut({ generated:new Date().toISOString(), matches:{}, note:'no_tennis_in_season' });
    return;
  }

  // Step 2: odds per comp, filtered to our books
  const bookParam=BOOKMAKERS.join(',');
  const matches={};
  let remaining=null;
  for(const key of tennisKeys){
    try{
      const url=`${HOST}/v4/sports/${key}/odds?bookmakers=${bookParam}&markets=${MARKET}&oddsFormat=decimal&apiKey=${KEY}`;
      const r=await fetch(url);
      remaining=r.headers.get('x-requests-remaining');
      if(!r.ok){ console.log(`  odds ${key}: ${r.status}`); continue; }
      const events=await r.json();
      for(const ev of events){
        const k1=surnameKey(ev.home_team), k2=surnameKey(ev.away_team);
        const byBook={};
        for(const bk of (ev.bookmakers||[])){
          const mkt=(bk.markets||[]).find(m=>m.key==='h2h');
          if(!mkt) continue;
          byBook[bk.title]={};
          for(const oc of (mkt.outcomes||[])) byBook[bk.title][surnameKey(oc.name)]=oc.price;
        }
        if(Object.keys(byBook).length){
          const pairKey=[k1,k2].sort().join('|');
          matches[pairKey]={ k1,k2, home:ev.home_team, away:ev.away_team, commence:ev.commence_time, byBook };
        }
      }
      console.log(`  odds ${key}: ${events.length} events`);
    }catch(e){ console.log(`  odds ${key} err: ${e.message}`); }
  }

  console.log(`  matched ${Object.keys(matches).length} markets · ${remaining||'?'} reqs left`);
  writeOut({ generated:new Date().toISOString(), reqsRemaining:remaining, books:BOOKMAKERS, matches });
})();

function writeOut(obj){
  if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR,{recursive:true});
  const file=path.join(OUT_DIR,'odds.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  console.log(`Wrote ${file}`);
}
