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

function parseCSV(text, tour){
  const lines=text.trim().split('\n');
  const h=lines[0].split(',');
  const iW=h.indexOf('winner_name'), iL=h.indexOf('loser_name'),
        iD=h.indexOf('tourney_date'), iSc=h.indexOf('score');
  const out=[];
  for(let i=1;i<lines.length;i++){
    const c=lines[i].split(',');
    if(c.length<h.length) continue;
    out.push({winner:c[iW],loser:c[iL],date:c[iD],score:iSc>=0?c[iSc]:'',tour});
  }
  return out;
}

// Count sets won by winner/loser from a score string; null for retirements/walkovers
function setCount(score){
  if(!score) return null;
  if(/ret|w\/o|walkover|def|abn/i.test(score)) return null;
  let ws=0, ls=0;
  for(const t of String(score).split(/\s+/)){
    const m=t.match(/^(\d+)-(\d+)/);
    if(m){ const a=+m[1], b=+m[2]; if(a>b) ws++; else if(b>a) ls++; }
  }
  if(ws+ls < 2) return null;
  return {ws, ls};
}

async function loadAll(){
  const thisYear=new Date().getFullYear();
  const urls=[];
  for(let y=thisYear-YEARS_TO_LOAD+1;y<=thisYear;y++){
    urls.push({u:`https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_${y}.csv`,tour:'ATP'});
    urls.push({u:`https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_${y}.csv`,tour:'WTA'});
  }
  let all=[];
  for(const {u,tour} of urls){
    try{
      const r=await fetch(u);
      if(!r.ok){ console.log(`  miss ${u.split('/').pop()}: ${r.status}`); continue; }
      const t=await r.text();
      const m=parseCSV(t, tour);
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
  const get=n=>{const k=normName(n);if(!R.has(k))R.set(k,{display:n,overall:BASE,matches:0,lastDate:null,atp:0,wta:0});return R.get(k);};
  const rec=md=>{
    if(!CONFIG.recencyDecay||!md||!refDate) return 1;
    const d1=parseSackDate(md),d2=parseSackDate(refDate);
    if(!d1||!d2) return 1;
    return Math.pow(0.5, Math.max(0,(d2-d1)/86400000)/CONFIG.halfLifeDays);
  };
  // straight-sets relationship: bin by favourite match-win prob → P(fav wins 2-0)
  // We collect this AS we train (using pre-update ratings = a genuine forecast).
  const ssBins = {}; // binKey(0..9) -> { n, fav20 }

  for(const m of matches){
    if(!m.winner||!m.loser) continue;
    const w=get(m.winner), l=get(m.loser);

    // record straight-sets stat using pre-update ratings (only once both have data)
    if(Math.min(w.matches,l.matches) >= 20){
      const sc=setCount(m.score);
      if(sc){
        const wIsFav = w.overall >= l.overall;
        const favProb = wIsFav ? expected(w.overall,l.overall) : expected(l.overall,w.overall);
        const bin = Math.min(9, Math.floor(favProb*10));
        if(!ssBins[bin]) ssBins[bin]={n:0,fav20:0};
        ssBins[bin].n++;
        // favourite won 2-0?  (winner is fav AND lost 0 sets)
        if(wIsFav && sc.ls===0) ssBins[bin].fav20++;
      }
    }

    const scale=rec(m.date);
    const e=expected(w.overall,l.overall);
    w.overall+=CONFIG.K*scale*(1-e);
    l.overall-=CONFIG.K*scale*(1-e);
    w.matches++; l.matches++; w.lastDate=m.date; l.lastDate=m.date;
    if(m.tour==='ATP'){w.atp++;l.atp++;} else if(m.tour==='WTA'){w.wta++;l.wta++;}
  }

  // Convert bins to a smooth lookup: P(fav 2-0 | favProb)
  const straightSets = {};
  for(let b=0;b<10;b++){
    if(ssBins[b] && ssBins[b].n>=30) straightSets[b] = ssBins[b].fav20/ssBins[b].n;
  }
  return { R, straightSets };
}

// ── BACKTEST ──────────────────────────────────────────────────────────
// Train on the older matches, predict the most recent ones the model hasn't
// seen, and measure real accuracy. Runs HERE in the Action (where every match
// is in memory) and writes results into ratings.json, so the deployed
// dashboard can show them without shipping the raw match list. Mirrors the
// browser's runBacktest exactly (same K, half-life, RELIABLE threshold).
function runBacktest(matches, holdoutFrac = 0.15){
  if(!matches || matches.length < 500) return { ok:false, reason:'not enough data' };
  const sorted=[...matches].sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const cutIdx=Math.floor(sorted.length*(1-holdoutFrac));
  const trainSet=sorted.slice(0,cutIdx);
  const testSet=sorted.slice(cutIdx);
  const refDate=trainSet.length ? trainSet[trainSet.length-1].date : null;

  const ratings=new Map();
  const get=n=>{const k=normName(n);if(!ratings.has(k))ratings.set(k,{overall:BASE,matches:0});return ratings.get(k);};
  const rec=md=>{
    if(!CONFIG.recencyDecay||!md||!refDate) return 1;
    const d1=parseSackDate(md),d2=parseSackDate(refDate);
    if(!d1||!d2) return 1;
    return Math.pow(0.5, Math.max(0,(d2-d1)/86400000)/CONFIG.halfLifeDays);
  };
  const update=(w,l,md)=>{
    const scale=rec(md);
    const e=expected(w.overall,l.overall);
    w.overall+=CONFIG.K*scale*(1-e);
    l.overall-=CONFIG.K*scale*(1-e);
    w.matches++; l.matches++;
  };

  for(const m of trainSet){
    if(!m.winner||!m.loser) continue;
    update(get(m.winner),get(m.loser),m.date);
  }

  const RELIABLE=30;
  let n=0,correct=0,logLossSum=0,brierSum=0,skipped=0;
  const bins=Array.from({length:10},()=>({sumPred:0,wins:0,n:0}));

  for(const m of testSet){
    if(!m.winner||!m.loser) continue;
    const w=ratings.get(normName(m.winner));
    const l=ratings.get(normName(m.loser));
    if(!w||!l||Math.min(w.matches,l.matches)<RELIABLE){
      skipped++;
      update(get(m.winner),get(m.loser),m.date);
      continue;
    }
    const pWin=expected(w.overall,l.overall);
    n++;
    if(pWin>0.5) correct++;
    logLossSum+=-Math.log(Math.max(pWin,1e-9));
    brierSum+=(1-pWin)*(1-pWin);
    // calibration from a fixed (alphabetical) perspective for a true curve
    const aFirst=normName(m.winner)<normName(m.loser);
    const pA=aFirst?pWin:(1-pWin);
    const aWon=aFirst?1:0;
    const bi=Math.min(9,Math.floor(pA*10));
    bins[bi].sumPred+=pA; bins[bi].wins+=aWon; bins[bi].n+=1;
    update(w,l,m.date);
  }

  const calibration=bins.map(b=>({
    sumPred:b.sumPred, realized:b.wins, n:b.n,
    avgPred:b.n?b.sumPred/b.n:0,
    winRate:b.n?b.wins/b.n:0,
  }));

  return {
    ok:true,
    tested:n, skipped,
    accuracy:n?correct/n:0,
    logLoss:n?logLossSum/n:0,
    brier:n?brierSum/n:0,
    calibration,
    trainSize:trainSet.length, testSize:testSet.length,
    generated:new Date().toISOString(),
  };
}

(async()=>{
  console.log('BONE ratings builder');
  console.log(`Loading ${YEARS_TO_LOAD} years ATP+WTA...`);
  const matches=await loadAll();
  console.log(`Total matches: ${matches.length}`);
  if(matches.length<1000){ console.error('Too few matches — aborting to avoid bad ratings'); process.exit(1); }

  console.log('Training ELO...');
  const { R, straightSets } = train(matches);

  // Compact output: round ratings, tag dominant tour
  const players={};
  let kept=0;
  for(const [k,v] of R){
    players[k]={
      n:v.display,
      o:Math.round(v.overall),
      m:v.matches,
      d:v.lastDate,
      t:(v.atp>=v.wta)?'ATP':'WTA',   // dominant tour for this player
    };
    kept++;
  }

  console.log('Straight-sets relationship (favProb bin → P(fav 2-0)):');
  Object.entries(straightSets).forEach(([b,p])=>console.log(`  ${b*10}-${b*10+10}%: ${(p*100).toFixed(0)}%`));

  // Run the held-out backtest on the full match set and embed the result.
  console.log('Running backtest...');
  const backtest = runBacktest(matches, 0.15);
  if(backtest.ok){
    console.log(`  backtest: ${backtest.tested} tested, ${backtest.skipped} skipped · accuracy ${(backtest.accuracy*100).toFixed(1)}% · logLoss ${backtest.logLoss.toFixed(4)} · brier ${backtest.brier.toFixed(4)}`);
  } else {
    console.log(`  backtest unavailable: ${backtest.reason}`);
  }

  const out={
    generated: new Date().toISOString(),
    config: CONFIG,
    base: BASE,
    matchCount: matches.length,
    refDate: matches.length ? matches[matches.length-1].date : null,
    straightSets,   // for set-handicap pricing
    backtest,       // precomputed held-out backtest (dashboard displays this)
    players,
  };

  if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR,{recursive:true});
  const file=path.join(OUT_DIR,'ratings.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const kb=(fs.statSync(file).size/1024).toFixed(0);
  console.log(`Wrote ${file}: ${kept} players, ${kb} KB`);
})();
