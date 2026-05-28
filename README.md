# BONE — deployment guide

BONE is a single-file tennis betting dashboard (`index.html`) backed by a
GitHub Actions pipeline that pre-builds the model and odds so the browser
loads tiny static files instead of doing heavy work.

## Repo layout

```
index.html                      ← the dashboard (commit at repo root)
data/ratings.json               ← built by the pipeline (ELO model, ~140KB)
data/odds.json                  ← built by the pipeline (today's odds)
scripts/build-ratings.js        ← trains ELO from Sackmann data
scripts/build-odds.js           ← fetches odds with the SECRET key
.github/workflows/build-data.yml← runs both every 6h, commits the data
```

## One-time setup

1. **Create a GitHub repo** and push everything in this folder, plus your
   `index.html` at the root.

2. **Add your Odds API key as a secret** (this is what hides it from the browser):
   - Repo → Settings → Secrets and variables → Actions → New repository secret
   - Name: `ODDS_API_KEY`
   - Value: your key from the-odds-api.com

3. **Enable Pages:** Settings → Pages → Source: deploy from branch `main`, root.

4. **Run the pipeline once manually:** Actions tab → "Build BONE data" → Run
   workflow. This creates the first `data/ratings.json` and `data/odds.json`.

5. **Point your domain** at the GitHub Pages URL (Settings → Pages → custom domain).

After that it's automatic: every 6 hours the Action rebuilds ratings + odds and
commits them. The dashboard always loads the latest.

## How the dashboard chooses its data source

`index.html` tries to load `data/ratings.json` and `data/odds.json` first.
- If present (deployed mode): fast load, no key in the browser. ✅
- If absent (opening index.html locally before the pipeline runs): it falls
  back to training in-browser from Sackmann CSVs and fetching odds directly
  with a key you paste in the sidebar.

So the same file works both ways. The security note about the exposed key only
applies to the local fallback — in deployed mode the key lives in the GitHub
Secret and never reaches the browser.

## The model (tuned)

Overall Elo, K=24, recency half-life 730 days, no surface adjustment. These
values were chosen by backtesting against ~4,000 held-out matches; the
fancier variants (surface ratings, margin-of-victory, dynamic K) were tested
and dropped because they didn't improve out-of-sample accuracy.

To re-tune: edit `CONFIG` in `scripts/build-ratings.js`, and keep the matching
`CONFIG` in `index.html` in sync.

## Cost

$0. GitHub Actions is free for public repos. The Odds API free tier (500
credits/month) is plenty at one h2h request per refresh.
