# NewinAI

An AI-news swipe app. **One story = one full-screen card.** Swipe up for the next, down to go
back — Inshorts meets Reels, built to be thumbed through.

Two parts, both on free tiers:

- **Static frontend** — vanilla HTML/CSS/JS. Fetches `cards.json`, renders full-screen cards,
  CSS `scroll-snap` handles the swipe.
- **Free pipeline** — a scheduled GitHub Action gathers AI news, summarises each *new* story once
  with the Gemini free tier (Groq fallback), and commits `cards.json`. Cost scales with new
  stories (~30/day), not readers.

```
index.html          feed container + card / state templates
styles.css          design tokens, textures, scroll-snap, states
app.js              render, progress, first-run hint, share, online/offline, theme
cards.json          Story[] — sample data, then overwritten by the pipeline
scripts/
  feeds.mjs         the feed list (edit here to add/drop a source)
  refresh.mjs       fetch → dedupe → summarise → write cards.json
.github/workflows/
  refresh.yml       cron (every 3h) + commit
netlify.toml        static hosting config
```

## Run the frontend locally

It's a static site — any static server works. From the repo root:

```bash
npx serve -l 5173 .
# or:  python -m http.server 5173
```

Open <http://localhost:5173>. It loads the sample `cards.json`, so the UI looks right before the
first real fetch. (Opening `index.html` via `file://` won't work — `fetch('cards.json')` needs a
server.)

## The data contract

`cards.json` is an array of objects in this exact shape:

```json
{
  "id": "stable-unique-string",
  "category": "Models",
  "headline": "one line",
  "summary": "~50 words, reworded",
  "source": "The Verge",
  "url": "https://...",
  "published": "2026-06-15T09:00:00Z",
  "image": "https://..."
}
```

`category` is one of `Models · Research · Funding · Tools · Policy · Other`. `image` is optional —
the UI renders fine without it (textured background) and applies a legibility scrim when present.

## Run the pipeline locally

```bash
npm install
GEMINI_API_KEY=...  node scripts/refresh.mjs    # GROQ_API_KEY optional fallback
```

It loads the current `cards.json`, fetches the feeds, **skips any id already summarised**, summarises
only what's new, and writes `cards.json` back (newest first, capped at 50). A dead feed is logged and
stepped over — one broken source never sinks the run.

### Where the API key goes

The key lives in **GitHub Actions secrets**, never in the client. The browser only ever fetches the
finished `cards.json`.

1. **GitHub → Settings → Secrets and variables → Actions → New repository secret**
2. Add `GEMINI_API_KEY` (free key from <https://aistudio.google.com/apikey>).
3. *(Optional)* add `GROQ_API_KEY` (free key from <https://console.groq.com/keys>) as the fallback.

The workflow (`.github/workflows/refresh.yml`) runs every 3 hours, summarises new stories, and commits
the updated `cards.json`. Trigger it by hand from the **Actions** tab → *Refresh AI news* → *Run
workflow*.

## Deploy (Netlify)

The site is already static, so there's no build step.

1. Push this repo to GitHub.
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Build command: *(empty)*. Publish directory: `.`. Deploy.

Vercel and Cloudflare Pages work the same way — point them at the repo root, no build command.

Because the cron job commits `cards.json` to the repo, every refresh redeploys the site automatically
with the latest stories.

## Notes / scope (v1)

- **Summaries are headline + RSS snippet only** — no full-text scraper (that's the part that breaks at
  2am when a site changes its HTML).
- Each story is summarised **once**, in the Action — never per reader.
- Feeds are fetched **server-side in the Action**, so there's no CORS problem in the browser.
- Edit `scripts/feeds.mjs` to change sources. **Verify a feed URL resolves before relying on it** —
  feeds move.

## Design

Build spec and visual board: `HANDOFF.md` and `NewinAI.dc.html` (the design handoff). Palette A
(Neon) is the default; light mode is a single attribute flip (toggle top-left).
