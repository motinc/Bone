#!/usr/bin/env node
/* =====================================================================
   NBA-MODEL-TEAMS — team rating model for moneyline / spread / total
   Trains on data/nba-games.json (from nba-seed-teams.js). Each team gets
   an offensive and defensive rating (points scored / allowed vs league
   average), plus home-court advantage. From a matchup we predict the
   expected margin and total, then derive:
     - moneyline  : P(home win) from margin distribution
     - spread     : P(home covers the line)
     - total      : P(over the line)
   Sweeps the recency/regression params, picks best by held-out log-loss.

   Run:  node nba-model-teams.js
   Writes data/nba-ratings.json for the dashboard.
   ===================================================================== */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'data', 'nba-games.json');
const OUT_FILE  = path.join(__dirname, 'data', 'nba-ratings.json');

// margin standard deviation for an NBA game — empirically ~12-13 pts.
// Used to turn an expected margin into win/cover probabilities.
const MARGIN_SD = 12.5;
const TOTAL_SD  = 18;     // total points SD, empirically larger

const HALFLIFE_GRID = [20, 35, 60];   // games-ago half-life (NBA season is short)
const HCA_GRID = [2.0, 2.8, 3.5];     // home court advantage (points) to test
const HOLDOUT_FRAC = 0.15;

// standard normal CDF (Abramowitz-Stegun approximation)
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z*z/2);
  let p = d * t * (0.3193815 + t*(-0.3565638 + t*(1.781478 + t*(-1.821256 + t*1.330274))));
  return z > 0 ? 1 - p : p;
}

function loadGames() {
  if (!fs.existsSync(DATA_FILE)) { console.error(`No ${DATA_FILE}. Run nba-seed-teams.js first.`); process.exit(1); }
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return (d.games || [])
    .filter(g => g.homeId && g.awayId && g.homeScore != null && g.awayScore != null)
    .sort((a,b) => (a.date||'').localeCompare(b.date||''));
}

// Train off/def ratings. Each team rating is points relative to league avg,
// updated game-by-game with recency weighting. off = scoring power,
// def = points-suppression power (higher def = allows fewer).
function train(games, halfLifeGames, hca) {
  const T = new Map();
  const get = (id, name) => {
    if (!T.has(id)) T.set(id, { off: 0, def: 0, n: 0, name });
    const t = T.get(id); if (name) t.name = name; return t;
  };
  // league average points per team per game — compute from data
  let lgPts = 0, gp = 0;
  for (const g of games) { lgPts += g.homeScore + g.awayScore; gp += 2; }
  const LG = gp ? lgPts / gp : 112;

  // learning rate from half-life: alpha so that weight halves every HL games
  const alpha = 1 - Math.pow(0.5, 1 / halfLifeGames);

  for (const g of games) {
    const h = get(g.homeId, g.homeName), a = get(g.awayId, g.awayName);
    // expected points for each side given current ratings + HCA
    const expH = LG + h.off - a.def + hca/2;
    const expA = LG + a.off - h.def - hca/2;
    // residuals: how much more/less they actually scored
    const rH = g.homeScore - expH;
    const rA = g.awayScore - expA;
    // update: home's offense & away's defense move from home scoring residual
    h.off += alpha * rH;
    a.def -= alpha * rH;     // if home scored more than expected, away D worse (def down)
    a.off += alpha * rA;
    h.def -= alpha * rA;
    h.n++; a.n++;
  }
  return { T, LG };
}

// Predict a matchup. Returns expected margin (home - away), total, and
// derived probabilities for ML / spread / total.
function predict(model, homeId, awayId, hca, spreadLine, totalLine) {
  const { T, LG } = model;
  const h = T.get(homeId), a = T.get(awayId);
  if (!h || !a) return null;
  const expH = LG + h.off - a.def + hca/2;
  const expA = LG + a.off - h.def - hca/2;
  const margin = expH - expA;       // + = home favored
  const total = expH + expA;
  // P(home wins): margin > 0
  const pHomeWin = normCdf(margin / MARGIN_SD);
  // P(home covers spreadLine): spreadLine is home's line, e.g. -3.5.
  // home covers if (actual margin) > -spreadLine  => margin + spreadLine > 0
  const pHomeCover = spreadLine != null ? normCdf((margin + spreadLine) / MARGIN_SD) : null;
  // P(over totalLine)
  const pOver = totalLine != null ? normCdf((total - totalLine) / TOTAL_SD) : null;
  return { margin, total, pHomeWin, pHomeCover, pOver, expH, expA };
}

function backtest(games, halfLife, hca) {
  if (games.length < 100) return { ok: false, reason: 'need 100+ games' };
  const cut = Math.floor(games.length * (1 - HOLDOUT_FRAC));
  const trainSet = games.slice(0, cut), testSet = games.slice(cut);
  // train on the trainSet, then walk testSet predicting BEFORE updating
  const model = train(trainSet, halfLife, hca);
  let n = 0, correct = 0, logloss = 0, brier = 0, mae = 0;
  for (const g of testSet) {
    const p = predict(model, g.homeId, g.awayId, hca, null, null);
    if (!p) continue;
    const ph = Math.max(1e-6, Math.min(1-1e-6, p.pHomeWin));
    const homeWon = g.homeWin ? 1 : 0;
    n++;
    if ((ph > 0.5) === (homeWon === 1)) correct++;
    logloss += -(homeWon*Math.log(ph) + (1-homeWon)*Math.log(1-ph));
    brier += (ph - homeWon) ** 2;
    mae += Math.abs(p.margin - (g.homeScore - g.awayScore));   // margin prediction error
  }
  if (n === 0) return { ok: false, reason: 'no testable games' };
  return { ok: true, halfLife, hca, tested: n, accuracy: correct/n, logLoss: logloss/n, brier: brier/n, marginMAE: mae/n };
}

(async () => {
  console.log('NBA-MODEL-TEAMS — off/def ratings, ML/spread/total\n');
  const games = loadGames();
  console.log(`Loaded ${games.length} final games`);
  if (games.length < 100) { console.error('Need 100+ games. Seed more first.'); process.exit(1); }

  console.log('\nSweeping (half-life, HCA) — scoring by held-out log-loss:');
  let best = null;
  for (const hl of HALFLIFE_GRID) {
    for (const hca of HCA_GRID) {
      const bt = backtest(games, hl, hca);
      if (!bt.ok) continue;
      console.log(`  hl=${hl}g hca=${hca}pts → acc ${(bt.accuracy*100).toFixed(1)}% · logloss ${bt.logLoss.toFixed(4)} · marginMAE ${bt.marginMAE.toFixed(1)}pts (n=${bt.tested})`);
      if (!best || bt.logLoss < best.logLoss) best = bt;
    }
  }
  if (!best) { console.error('Backtest failed for all configs.'); process.exit(1); }
  console.log(`\nBest: half-life=${best.halfLife}g, HCA=${best.hca}pts — acc ${(best.accuracy*100).toFixed(1)}%, logloss ${best.logLoss.toFixed(4)}, marginMAE ${best.marginMAE.toFixed(1)}pts`);

  // train final on all games
  const model = train(games, best.halfLife, best.hca);
  const teams = {};
  for (const [id, t] of model.T) {
    if (t.n < 5) continue;
    teams[id] = { name: t.name, off: +t.off.toFixed(2), def: +t.def.toFixed(2), n: t.n };
  }
  const out = {
    generated: new Date().toISOString(),
    config: { halfLife: best.halfLife, hca: best.hca, marginSD: MARGIN_SD, totalSD: TOTAL_SD, leagueAvg: +model.LG.toFixed(1) },
    gameCount: games.length,
    backtest: { accuracy: best.accuracy, logLoss: best.logLoss, brier: best.brier, marginMAE: best.marginMAE, tested: best.tested },
    teams,
  };
  if (!fs.existsSync(path.dirname(OUT_FILE))) fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`\nWrote ${OUT_FILE}: ${Object.keys(teams).length} teams.`);
  console.log('marginMAE is the key number — how many points off the predicted margin is, on average.');
})();
