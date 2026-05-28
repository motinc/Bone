#!/usr/bin/env node
/* =====================================================================
   BONE — ratings builder
   Fetches Sackmann ATP/WTA CSVs, trains the ELO model (same logic as the
   browser), and writes a compact data/ratings.json the dashboard loads.

   Runs in GitHub Actions (Node 20+, global fetch available).
   No secrets needed for this script — Sackmann data is public.
   ===================================================================== */

const fs = require('fs');
const path = require('path');

// ── Config — TUNED via backtest against 4,000 held-out matches ──
// Findings: K=24 + 730d recency beat the K=32 default (logLoss 0.6153 vs 0.6185).
// Surface ratings, margin-of-victory, dynamic-K, and retirement-skipping were
// all tested and found neutral-to-harmful, so they're OFF. Simpler = better here.
const YEARS_TO_LOAD = 8;          // 8 yrs ATP+WTA ≈ 39k matches
const BASE = 1500;
const CONFIG = {
  K: 24,
  recencyDecay: true,
  halfLifeDays: 730,
};

const OUT_DIR = path.join(__dirname, '..', 'data');

// ── helpers (mirror the browser model exactly) ──
const normName = s => !s ? '' : s.normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-zA-Z\s\-']/g,'').trim().toLowerCase().replace(/\s+/g,' ');
const expected = (a,b) => 1/(1+Math.pow(10,(b-a)/400));
const parseSackDate = d => {
  if(!d || String(d).length<8) return null;
  d=String(d); return new Date(+d.slice(0,4), +d.slice(4,6)-1, +d.slice(6,8)).getTime();
};

function parseCSV(text){
  const lines=text.trim().split('\n');
  const h=lines[0].split(',');
  const iW=h.indexOf('winner_name'), iL=h.indexOf('loser_name'),
        iD=h.indexOf('tourney_date');
  const out=[];
  for(let i=1;i<lines.length;i++){
    const c=lines[i].split(',');
    if(c.length<h.length) continue;
    out.push({winner:c[iW],loser:c[iL],date:c[iD]});
  }
  return out;
}

async function loadAll(){
  const thisYear=new Date().getFullYear();
  const urls=[];
  for(let y=thisYear-YEARS_TO_LOAD+1;y<=thisYear;y++){
    urls.push(`https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_${y}.csv`);
    urls.push(`https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_${y}.csv`);
  }
  let all=[];
  for(const u of urls){
    try{
      const r=await fetch(u);
      if(!r.ok){ console.log(`  miss ${u.split('/').pop()}: ${r.status}`); continue; }
      const t=await r.text();
      const m=parseCSV(t);
      all=all.concat(m);
      console.log(`  loaded ${u.split('/').pop()}: ${m.length}`);
    }catch(e){ console.log(`  err ${u}: ${e.message}`); }
  }
  all.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  return all;
}

function train(matches){
  const refDate = matches.length ? matches[matches.length-1].date : null;
  const R=new Map();
  const get=n=>{const k=normName(n);if(!R.has(k))R.set(k,{display:n,overall:BASE,matches:0,lastDate:null});return R.get(k);};
  const rec=md=>{
    if(!CONFIG.recencyDecay||!md||!refDate) return 1;
    const d1=parseSackDate(md),d2=parseSackDate(refDate);
    if(!d1||!d2) return 1;
    return Math.pow(0.5, Math.max(0,(d2-d1)/86400000)/CONFIG.halfLifeDays);
  };
  for(const m of matches){
    if(!m.winner||!m.loser) continue;
    const w=get(m.winner), l=get(m.loser);
    const scale=rec(m.date);
    const e=expected(w.overall,l.overall);
    w.overall+=CONFIG.K*scale*(1-e);
    l.overall-=CONFIG.K*scale*(1-e);
    w.matches++; l.matches++; w.lastDate=m.date; l.lastDate=m.date;
  }
  return R;
}

(async()=>{
  console.log('BONE ratings builder');
  console.log(`Loading ${YEARS_TO_LOAD} years ATP+WTA...`);
  const matches=await loadAll();
  console.log(`Total matches: ${matches.length}`);
  if(matches.length<1000){ console.error('Too few matches — aborting to avoid bad ratings'); process.exit(1); }

  console.log('Training ELO...');
  const R=train(matches);

  // Compact output: round ratings
  const players={};
  let kept=0;
  for(const [k,v] of R){
    players[k]={
      n:v.display,
      o:Math.round(v.overall),
      m:v.matches,
      d:v.lastDate,
    };
    kept++;
  }

  const out={
    generated: new Date().toISOString(),
    config: CONFIG,
    base: BASE,
    matchCount: matches.length,
    refDate: matches.length ? matches[matches.length-1].date : null,
    players,
  };

  if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR,{recursive:true});
  const file=path.join(OUT_DIR,'ratings.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const kb=(fs.statSync(file).size/1024).toFixed(0);
  console.log(`Wrote ${file}: ${kept} players, ${kb} KB`);
})();
