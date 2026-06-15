/* ============================================================
   NewinAI — pipeline
   Runs in GitHub Actions (cron). Fetches feeds server-side,
   dedupes, summarises ONLY genuinely-new stories with Gemini
   (Groq fallback), and writes cards.json newest-first.

   The API key lives in Actions secrets and is read from env here.
   The browser never sees it and never fetches the feeds itself.

   Usage:  node scripts/refresh.mjs
   Env:    GEMINI_API_KEY   (primary)
           GROQ_API_KEY     (fallback, optional)
   ============================================================ */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Parser from 'rss-parser';
import { FEEDS, CATEGORIES, MAX_CARDS, MAX_NEW_PER_RUN } from './feeds.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARDS_PATH = join(__dirname, '..', 'cards.json');
// Ids of every story we've already processed (carded OR skipped as non-AI), so the
// LLM is never called twice on the same story — even after it ages past the card cap.
const SEEN_PATH = join(__dirname, 'seen-ids.json');
const SEEN_CAP = 4000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
// Throttle between LLM calls, per provider, to respect free-tier rate limits.
// Gemini free tier ~15 req/min (~4.5s); Groq free tier ~30 req/min (~2.1s).
const GEMINI_THROTTLE_MS = Number(process.env.GEMINI_THROTTLE_MS ?? 4500);
const GROQ_THROTTLE_MS   = Number(process.env.GROQ_THROTTLE_MS ?? 2100);

const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': 'NewinAI/1.0 (+github-actions)' } });

const log = (...a) => console.log('[refresh]', ...a);
const warn = (...a) => console.warn('[refresh][warn]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fetch with a hard timeout so a slow endpoint can never hang the whole run.
function fetchT(url, opts = {}, ms = 25000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

/* ---------- 1. fetch + normalise every feed (fail soft) ---------- */
// Cheap, free pre-filter for broad/general feeds (Ars main site, HN front page)
// so obviously-non-AI stories never reach the LLM. AI-only feeds skip this.
const AI_RE = /\b(a\.?i\.?|artificial intelligence|machine[- ]?learning|ml|llm|gpt|genai|generative|neural|deep[- ]?learning|models?|openai|anthropic|claude|gemini|deepmind|llama|mistral|nvidia|gpus?|transformers?|diffusion|agents?|agentic|inference|fine[- ]?tun|chatbot|copilot|reinforcement learning|dataset|embedding|multimodal|hugging ?face|chatgpt|deepseek)\b/i;

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function stableId(source, link, guid) {
  return (guid || link || `${source}:${Math.random()}`).trim();
}

async function fetchRss(feed) {
  const parsed = await parser.parseURL(feed.url);
  return (parsed.items || []).map(item => ({
    id: stableId(feed.name, item.link, item.guid || item.id),
    source: feed.name,
    url: item.link || '',
    headline: stripHtml(item.title).slice(0, 200),
    snippet: stripHtml(item.contentSnippet || item.content || item.summary || '').slice(0, 600),
    published: item.isoDate || item.pubDate || new Date().toISOString(),
  })).filter(s => s.url && s.headline);
}

// Hacker News front page via Algolia.
async function fetchHn(feed) {
  const res = await fetchT(feed.url, { headers: { 'User-Agent': 'NewinAI/1.0' } }, 15000);
  if (!res.ok) throw new Error(`HN HTTP ${res.status}`);
  const data = await res.json();
  return (data.hits || [])
    .filter(h => (h.title || h.story_title) && (h.url || h.story_url))
    .map(h => ({
      id: `hn:${h.objectID}`,
      source: 'Hacker News',
      url: h.url || h.story_url,
      headline: stripHtml(h.title || h.story_title).slice(0, 200),
      snippet: '',
      published: h.created_at || new Date().toISOString(),
    }));
}

async function fetchAll() {
  const out = [];
  for (const feed of FEEDS) {
    try {
      let items = feed.kind === 'hn' ? await fetchHn(feed) : await fetchRss(feed);
      // Broad feeds get a keyword pre-filter; AI-only feeds pass through untouched.
      if (!feed.aiOnly) {
        const before = items.length;
        items = items.filter(it => AI_RE.test(`${it.headline} ${it.snippet}`));
        log(`${feed.name}: ${items.length} items (AI-filtered from ${before})`);
      } else {
        log(`${feed.name}: ${items.length} items`);
      }
      out.push(...items);
    } catch (err) {
      warn(`skipping ${feed.name}: ${err.message}`); // one dead feed must not sink the run
    }
  }
  return out;
}

/* ---------- 2. dedupe + pick the newest unsummarised ---------- */
function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const key = it.url || it.id;
    if (!seen.has(key)) seen.set(key, it);
  }
  return [...seen.values()].sort((a, b) => new Date(b.published) - new Date(a.published));
}

/* ---------- 3. summarise (Gemini, Groq fallback) ---------- */
const SYSTEM = `You summarise AI news for a swipe-card app. For the given story, return JSON ONLY (no markdown, no prose) in exactly this shape:
{"relevant": boolean, "summary": string, "category": "Models"|"Research"|"Funding"|"Tools"|"Policy"|"Other"}
Rules:
- relevant: true only if the story is genuinely about artificial intelligence, machine learning, or the AI industry (labs, models, AI funding, AI policy, AI tooling/research). Set false for general tech, space, cars, gadgets, science, sports, or business news that merely mentions a tech company. When false, summary and category can be empty strings.
- summary: about 50 words, reworded ENTIRELY in plain English. Never paste the article's own sentences.
- Neutral tone, quietly skeptical of hype.
- category: choose exactly one from the list that best fits.`;

function userPrompt(story) {
  return `Headline: ${story.headline}\nSource: ${story.source}\nSnippet: ${story.snippet || '(none)'}\n\nReturn JSON only.`;
}

function parseModelJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    if (obj.relevant === false) return { relevant: false };  // not AI news — skip it
    if (!obj.summary) return null;
    if (!CATEGORIES.includes(obj.category)) obj.category = 'Other';
    return { relevant: true, summary: String(obj.summary).trim(), category: obj.category };
  } catch (_) { return null; }
}

// pull a retry hint (seconds) out of a Gemini 429 body, if present
function retryDelaySeconds(body) {
  const m = /"retryDelay"\s*:\s*"(\d+)s"/.exec(body || '');
  return m ? Number(m[1]) : null;
}

async function summariseGemini(story, { allowRetry = true } = {}) {
  if (!GEMINI_API_KEY) throw new Error('no GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt(story) }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
    }),
  });
  if (res.status === 429) {
    const body = (await res.text()).slice(0, 300);
    const wait = retryDelaySeconds(body);
    // A genuine quota/billing exhaustion ("check your plan and billing") won't
    // recover this run — flag it so the caller can stop calling Gemini entirely.
    const exhausted = /quota|billing|plan/i.test(body) && wait == null;
    // One short retry only for a transient per-minute limit that names a delay.
    if (allowRetry && !exhausted && wait != null && wait <= 30) {
      warn(`gemini 429, retrying in ${wait}s`);
      await sleep(wait * 1000);
      return summariseGemini(story, { allowRetry: false });
    }
    throw Object.assign(new Error(`gemini rate limit — ${body}`), { rateLimited: true, exhausted });
  }
  // 403 = key disabled / API not enabled — also a per-run dead end.
  if (!res.ok) {
    throw Object.assign(new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`),
      { exhausted: res.status === 403 });
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  const parsed = parseModelJson(text);
  if (!parsed) throw new Error('gemini returned unparseable JSON');
  return parsed;
}

async function summariseGroq(story) {
  if (!GROQ_API_KEY) throw new Error('no GROQ_API_KEY');
  const res = await fetchT('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(story) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const parsed = parseModelJson(data?.choices?.[0]?.message?.content || '');
  if (!parsed) throw new Error('groq returned unparseable JSON');
  return parsed;
}

// Circuit breaker: once Gemini reports a non-recoverable quota/billing/disabled
// error, stop calling it for the rest of this run and go straight to Groq.
let geminiDown = false;

async function summarise(story) {
  if (GEMINI_API_KEY && !geminiDown) {
    try {
      return { ...await summariseGemini(story), provider: 'gemini' };
    } catch (err) {
      if (err.exhausted) {
        geminiDown = true;
        warn(`gemini unavailable (${err.message.slice(0, 120)}) — switching to groq for the rest of this run`);
      }
      if (!GROQ_API_KEY) throw err;        // no fallback configured — surface it
      if (!err.exhausted) warn(`gemini failed (${err.message.slice(0, 120)}); trying groq`);
      return { ...await summariseGroq(story), provider: 'groq' };
    }
  }
  return { ...await summariseGroq(story), provider: 'groq' };   // Groq-only / Gemini circuit-broken
}

/* ---------- 4. merge + write ---------- */
async function loadExisting() {
  try {
    const raw = await readFile(CARDS_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

async function loadSeen() {
  try {
    const arr = JSON.parse(await readFile(SEEN_PATH, 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (_) {
    return new Set();
  }
}

async function saveSeen(set) {
  const arr = [...set].slice(-SEEN_CAP);   // keep it bounded; newest ids win
  await writeFile(SEEN_PATH, JSON.stringify(arr) + '\n', 'utf8');
}

async function main() {
  if (!GEMINI_API_KEY && !GROQ_API_KEY) {
    console.error('No GEMINI_API_KEY or GROQ_API_KEY set. Aborting.');
    process.exit(1);
  }

  const existing = await loadExisting();
  const existingIds = new Set(existing.map(c => c.id));
  const seen = await loadSeen();
  existing.forEach(c => seen.add(c.id));   // current cards count as already-processed

  const all = dedupe(await fetchAll());
  const fresh = all
    .filter(s => !existingIds.has(s.id) && !seen.has(s.id))
    .slice(0, MAX_NEW_PER_RUN);
  log(`fetched ${all.length} unique, ${fresh.length} new to summarise`);

  const newCards = [];
  let skipped = 0;
  let consecutiveFails = 0;
  for (const story of fresh) {
    let provider = 'groq';   // for throttle accounting if the call throws
    try {
      const result = await summarise(story);
      provider = result.provider;
      consecutiveFails = 0;
      seen.add(story.id);    // processed — never summarise this id again
      if (!result.relevant) {
        skipped++;
        log(`- [skip non-AI] ${story.headline.slice(0, 60)}`);
      } else {
        newCards.push({
          id: story.id,
          category: result.category,
          headline: story.headline,
          summary: result.summary,
          source: story.source,
          url: story.url,
          published: new Date(story.published).toISOString(),
        });
        log(`+ [${result.category}] ${story.headline.slice(0, 60)}`);
      }
    } catch (err) {
      consecutiveFails++;
      warn(`could not summarise "${story.headline.slice(0, 50)}": ${err.message}`);
      // No working fallback + provider keeps failing → stop early rather than
      // burn the whole queue (and Action minutes) on calls that won't land.
      if (!GROQ_API_KEY && consecutiveFails >= 5) {
        warn('5 summaries failed in a row with no fallback — stopping early. Add GROQ_API_KEY or check the Gemini free-tier quota.');
        break;
      }
    }
    await sleep(provider === 'gemini' ? GEMINI_THROTTLE_MS : GROQ_THROTTLE_MS);
  }

  // Persist the seen cache even when nothing was carded, so skipped non-AI
  // stories aren't re-summarised on every run.
  await saveSeen(seen);

  if (!newCards.length) {
    log(`no new cards this run (${skipped} skipped as non-AI) — leaving cards.json unchanged`);
    return;
  }

  const merged = [...newCards, ...existing]
    .sort((a, b) => new Date(b.published) - new Date(a.published))
    .slice(0, MAX_CARDS);

  await writeFile(CARDS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  log(`wrote ${merged.length} cards (${newCards.length} new, ${skipped} skipped as non-AI)`);
}

main().catch(err => { console.error('[refresh] fatal:', err); process.exit(1); });
