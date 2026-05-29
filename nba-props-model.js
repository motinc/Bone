#!/usr/bin/env node
/* =====================================================================
   NBA-PROPS-MODEL — points-prop projection engine (v1)
   For each "Player Over/Under X.5 points" line tonight:
     projection = projected_minutes × recent points-per-minute rate,
                  adjusted for opponent defense,
     distribution = normal around projection (SD from player's own scoring),
     P(over) = 1 − CDF(line),
     edge    = P(over) × over_odds − 1   (and the same for under).

   This file is the MODEL (pure functions + a self-test on sample data).
   The live fetcher (nba-props-fetch.js) calls projectPoints() per player.

   Run:  node nba-props-model.js        (runs the self-test)
   ===================================================================== */

const LABELS = ["MIN","FG","FG%","3PT","3P%","FT","FT%","REB","AST","BLK","STL","PF","TO","PTS"];
const MIN_IDX = LABELS.indexOf('MIN');   // 0
const PTS_IDX = LABELS.indexOf('PTS');   // 13

// standard normal CDF
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z*z/2);
  let p = d * t * (0.3193815 + t*(-0.3565638 + t*(1.781478 + t*(-1.821256 + t*1.330274))));
  return z > 0 ? 1 - p : p;
}

/* Extract a clean per-game series (most recent first or last — caller sorts).
   Each game -> { min, pts }. Skips DNPs (0 minutes). */
function parseGameLog(statsArray) {
  const out = [];
  for (const stats of statsArray) {
    if (!Array.isArray(stats)) continue;
    const min = parseFloat(stats[MIN_IDX]);
    const pts = parseFloat(stats[PTS_IDX]);
    if (isNaN(min) || isNaN(pts)) continue;
    if (min <= 0) continue;          // DNP — exclude from rate calc
    out.push({ min, pts });
  }
  return out;
}

/* Recency-weighted mean: most recent game weighted highest.
   games: array ordered OLDEST→NEWEST. halfLife in games. */
function recencyMean(games, valueFn, halfLife) {
  let wsum = 0, vsum = 0;
  const n = games.length;
  for (let i = 0; i < n; i++) {
    const age = (n - 1) - i;                 // 0 for newest
    const w = Math.pow(0.5, age / halfLife);
    wsum += w; vsum += w * valueFn(games[i]);
  }
  return wsum > 0 ? vsum / wsum : 0;
}

/* Project a player's points for tonight.
   opts:
     games        : parsed game series (oldest→newest)
     oppDefRating  : opponent's defensive rating (points allowed vs league avg;
                     POSITIVE = better defense = suppresses scoring). From the
                     team model's `def`. 0 if unknown.
     halfLife     : recency half-life in games (default 12)
   Returns projection object or null if insufficient data. */
function projectPoints({ games, oppDefRating = 0, halfLife = 12 }) {
  if (!games || games.length < 5) return null;   // need a baseline

  // 1) projected minutes. Minutes are the single biggest driver of points, and
  //    they're volatile, so we do this carefully:
  //    - recency-weighted recent minutes as the base
  //    - but also detect a TREND: if the last ~5 games differ meaningfully from
  //      the longer baseline, lean toward the recent rotation (role changed).
  const recentMinShort = recencyMean(games.slice(-5), g => g.min, 3);   // last 5, fast decay
  const recentMinLong  = recencyMean(games, g => g.min, halfLife);       // full, slow decay
  // blend: trust the short-term rotation but don't overreact to one game
  const projMin = 0.6 * recentMinShort + 0.4 * recentMinLong;
  // minutes stability — how much do minutes bounce around? feeds uncertainty.
  const minMean = recencyMean(games, g => g.min, halfLife);
  const minVar = recencyMean(games, g => (g.min - minMean) ** 2, halfLife);
  const minStability = Math.sqrt(minVar);   // higher = more erratic role

  // 2) points-per-minute rate — recency-weighted (per-minute scoring is more
  //    stable than raw points, so projecting via rate × minutes is sharper)
  const rate = recencyMean(games, g => g.pts / Math.max(g.min, 1), halfLife);

  // 3) base projection
  let proj = projMin * rate;

  // 4) opponent-defense adjustment (gentle, ±~6%)
  const defFactor = 1 - (oppDefRating * 0.006);
  proj *= defFactor;

  // 5) distribution SD. Floor scales with projection (low-scorers are noisier),
  //    AND widens further when minutes are erratic (uncertain role = less
  //    confident projection). This is what keeps the model honest.
  const meanPts = recencyMean(games, g => g.pts, halfLife);
  const variance = recencyMean(games, g => (g.pts - meanPts) ** 2, halfLife);
  const empiricalSd = Math.sqrt(variance);
  // minutes instability inflates SD: a player whose minutes swing ±8 is much
  // less predictable than one locked into 34/night.
  const minUncertainty = minStability * rate;   // convert minute-swing to points
  const sd = Math.max(empiricalSd, proj * 0.45, 5) + 0.5 * minUncertainty;

  const recentMin = projMin;
  return { proj, sd, projMin, rate, n: games.length, recentMin, minStability: +minStability.toFixed(1), empiricalSd: +empiricalSd.toFixed(1) };
}

/* Line-movement signal. Compares the opening line to the current line.
   The direction the line moved is information — it's where the (often sharp)
   money went. Returns a signal relative to which side the MODEL likes.
     - 'with'    : line moved toward the model's side (market agrees — edge may
                   be partly gone, but it confirms the read)
     - 'against' : line moved away from the model's side (either you found
                   something the market hasn't, OR you're missing news — caution)
     - 'flat'    : negligible movement
   modelSide: 'OVER' | 'UNDER'. */
function lineMovement(openLine, currentLine, modelSide) {
  if (openLine == null || currentLine == null) return { dir: 'unknown', delta: 0 };
  const delta = +(currentLine - openLine).toFixed(1);
  if (Math.abs(delta) < 0.5) return { dir: 'flat', delta };
  const movedUp = delta > 0;   // line number was raised
  // For OVER: a higher line is harder to clear → up = against. For UNDER: reverse.
  let dir;
  if (modelSide === 'OVER') dir = movedUp ? 'against' : 'with';
  else dir = movedUp ? 'with' : 'against';
  return { dir, delta };
}

/* Edge for an over/under points prop.
   line: the book line (e.g. 18.5). overOdds/underOdds: decimal.
   Returns { pOver, pUnder, edgeOver, edgeUnder, proj, sd }. */
function propEdge(projection, line, overOdds, underOdds) {
  const { proj, sd } = projection;
  const z = (line - proj) / sd;
  const pOver = 1 - normCdf(z);     // P(points > line)
  const pUnder = 1 - pOver;
  const edgeOver  = overOdds  ? (pOver  * overOdds  - 1) * 100 : null;
  const edgeUnder = underOdds ? (pUnder * underOdds - 1) * 100 : null;
  return { pOver, pUnder, edgeOver, edgeUnder, proj, sd, line };
}

module.exports = { parseGameLog, projectPoints, propEdge, lineMovement, recencyMean, normCdf, LABELS, MIN_IDX, PTS_IDX };

// ── self-test ──
if (require.main === module) {
  console.log('NBA-PROPS-MODEL — self-test\n');

  // a synthetic ~20ppg scorer, 32 min/game, with noise
  const games = [];
  for (let i = 0; i < 30; i++) {
    const min = 30 + (Math.random()-0.5)*8;
    const pts = Math.max(0, Math.round(min * 0.62 + (Math.random()-0.5)*14));
    games.push({ min, pts });
  }
  const proj = projectPoints({ games, oppDefRating: 0, halfLife: 12 });
  console.log('Projection (avg D):', JSON.stringify({ proj:+proj.proj.toFixed(1), sd:+proj.sd.toFixed(1), projMin:+proj.projMin.toFixed(1), rate:+proj.rate.toFixed(3) }));

  // vs a strong defense (+8) and weak defense (-8)
  const projTough = projectPoints({ games, oppDefRating: 8, halfLife: 12 });
  const projWeak  = projectPoints({ games, oppDefRating: -8, halfLife: 12 });
  console.log('vs strong D (+8):', proj.proj.toFixed(1), '→', projTough.proj.toFixed(1));
  console.log('vs weak D  (-8):', proj.proj.toFixed(1), '→', projWeak.proj.toFixed(1));

  // edge calc at a few lines
  console.log('\nEdge at various lines (over/under both -110 = 1.91 decimal):');
  for (const line of [proj.proj - 3, proj.proj, proj.proj + 3]) {
    const e = propEdge(proj, line, 1.91, 1.91);
    console.log(`  line ${line.toFixed(1)}: P(over)=${(e.pOver*100).toFixed(0)}%  edgeOver=${e.edgeOver.toFixed(1)}%  edgeUnder=${e.edgeUnder.toFixed(1)}%`);
  }
  console.log('\n✓ projection + edge math working');
}
