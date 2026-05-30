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
        iD=h.indexOf('tourney_date'), iSc=h.indexOf('score'),
        iBo=h.indexOf('best_of');
  const out=[];
  for(let i=1;i<lines.length;i++){
    const c=lines[i].split(',');
    if(c.length<h.length) continue;
    out.push({winner:c[iW],loser:c[iL],date:c[iD],score:iSc>=0?c[iSc]:'',
              bestOf:iBo>=0?(+c[iBo]||3):3, tour});
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
  // Scoreline relationship: bin by favourite match-win prob → distribution over
  // outcomes from the FAVOURITE's perspective. We keep SEPARATE tables for
  // best-of-3 and best-of-5, because a Slam men's match (bo5) has different
  // scorelines (3-0/3-1/3-2) and straight-set rates than a bo3 match.
  //   bo3: fav20, fav21, fav12, fav02
  //   bo5: fav30, fav31, fav32, fav23, fav13, fav03  (last three = fav loses)
  const ssBins  = {}; // bo3: bin -> { n, fav20, fav21, fav12, fav02 }
  const ss5Bins = {}; // bo5: bin -> { n, fav30, fav31, fav32, fav23, fav13, fav03 }

  for(const m of matches){
    if(!m.winner||!m.loser) continue;
    const w=get(m.winner), l=get(m.loser);

    // record scoreline stat using pre-update ratings (only once both have data)
    if(Math.min(w.matches,l.matches) >= 20){
      const sc=setCount(m.score);
      if(sc){
        const wIsFav = w.overall >= l.overall;
        const favProb = wIsFav ? expected(w.overall,l.overall) : expected(l.overall,w.overall);
        const bin = Math.min(9, Math.floor(favProb*10));
        const bo5 = m.bestOf === 5;
        if(bo5){
          if(!ss5Bins[bin]) ss5Bins[bin]={n:0,fav30:0,fav31:0,fav32:0,fav23:0,fav13:0,fav03:0};
          ss5Bins[bin].n++;
          if(wIsFav){
            // fav won: loser took 0/1/2 sets → 3-0 / 3-1 / 3-2
            if(sc.ls===0) ss5Bins[bin].fav30++;
            else if(sc.ls===1) ss5Bins[bin].fav31++;
            else ss5Bins[bin].fav32++;
          } else {
            // fav lost: they (match loser) took sc.ls sets → fav 2-3 / 1-3 / 0-3
            if(sc.ls===2) ss5Bins[bin].fav23++;
            else if(sc.ls===1) ss5Bins[bin].fav13++;
            else ss5Bins[bin].fav03++;
          }
        } else {
          if(!ssBins[bin]) ssBins[bin]={n:0,fav20:0,fav21:0,fav12:0,fav02:0};
          ssBins[bin].n++;
          if(wIsFav){
            if(sc.ls===0) ssBins[bin].fav20++; else ssBins[bin].fav21++;
          } else {
            if(sc.ls===1) ssBins[bin].fav12++; else ssBins[bin].fav02++;
          }
        }
      }
    }

    const scale=rec(m.date);
    const e=expected(w.overall,l.overall);
    w.overall+=CONFIG.K*scale*(1-e);
    l.overall-=CONFIG.K*scale*(1-e);
    w.matches++; l.matches++; w.lastDate=m.date; l.lastDate=m.date;
    if(m.tour==='ATP'){w.atp++;l.atp++;} else if(m.tour==='WTA'){w.wta++;l.wta++;}
  }

  // Convert bins to smooth lookups.
  // bo3: straightSets[bin]=P(fav 2-0), scorelines[bin]={p20,p21,p12,p02}
  // bo5: straightSets5[bin]=P(fav 3-0... actually P(fav -1.5 cover)), see note.
  const straightSets = {};
  const scorelines = {};
  for(let b=0;b<10;b++){
    const x=ssBins[b];
    if(x && x.n>=30){
      straightSets[b] = x.fav20/x.n;
      scorelines[b] = { p20:x.fav20/x.n, p21:x.fav21/x.n, p12:x.fav12/x.n, p02:x.fav02/x.n, n:x.n };
    }
  }
  // bo5 needs a smaller threshold — far fewer bo5 matches exist (Slams only).
  const straightSets5 = {};
  const scorelines5 = {};
  for(let b=0;b<10;b++){
    const x=ss5Bins[b];
    if(x && x.n>=15){
      const n=x.n;
      scorelines5[b] = {
        p30:x.fav30/n, p31:x.fav31/n, p32:x.fav32/n,
        p23:x.fav23/n, p13:x.fav13/n, p03:x.fav03/n, n,
      };
      // For a -1.5 SET handicap in bo5, the favourite covers iff they win by 2+
      // sets: that's 3-0 or 3-1 (NOT 3-2). So the "straight/handicap" cash prob
      // is fav30+fav31. Store that as the bo5 analogue of straightSets.
      straightSets5[b] = (x.fav30 + x.fav31)/n;
    }
  }
  return { R, straightSets, scorelines, straightSets5, scorelines5 };
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
  const { R, straightSets, scorelines, straightSets5, scorelines5 } = train(matches);

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

  console.log('Scoreline distribution by favProb bin (fav 2-0 / 2-1 / 1-2 / 0-2):');
  Object.entries(scorelines).forEach(([b,s])=>console.log(`  ${b*10}-${b*10+10}%: ${(s.p20*100).toFixed(0)}% / ${(s.p21*100).toFixed(0)}% / ${(s.p12*100).toFixed(0)}% / ${(s.p02*100).toFixed(0)}%  (n=${s.n})`));
  console.log('Best-of-5 scoreline distribution (fav 3-0 / 3-1 / 3-2 / 2-3 / 1-3 / 0-3):');
  Object.entries(scorelines5).forEach(([b,s])=>console.log(`  ${b*10}-${b*10+10}%: ${(s.p30*100).toFixed(0)}/${(s.p31*100).toFixed(0)}/${(s.p32*100).toFixed(0)} · ${(s.p23*100).toFixed(0)}/${(s.p13*100).toFixed(0)}/${(s.p03*100).toFixed(0)}  (n=${s.n})`));

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
    straightSets,   // for set-handicap pricing (best-of-3)
    scorelines,     // full scoreline distribution by favProb bin (best-of-3)
    straightSets5,  // best-of-5: P(fav covers -1.5 sets = wins 3-0 or 3-1)
    scorelines5,    // best-of-5 full distribution (3-0/3-1/3-2/2-3/1-3/0-3)
    backtest,       // precomputed held-out backtest (dashboard displays this)
    players,
  };

  if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR,{recursive:true});
  const file=path.join(OUT_DIR,'ratings.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const kb=(fs.statSync(file).size/1024).toFixed(0);
  console.log(`Wrote ${file}: ${kept} players, ${kb} KB`);
})();
