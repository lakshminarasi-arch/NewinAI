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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
// Throttle between LLM calls. Gemini's free tier is ~15 req/min, so default ~4.5s
// keeps us safely under it. Set THROTTLE_MS=0 if you're only using Groq.
const THROTTLE_MS = process.env.THROTTLE_MS != null
  ? Number(process.env.THROTTLE_MS)
  : (GEMINI_API_KEY ? 4500 : 600);

const parser = new Parser({ timeout: 15000, headers: { 'User-Agent': 'NewinAI/1.0 (+github-actions)' } });

const log = (...a) => console.log('[refresh]', ...a);
const warn = (...a) => console.warn('[refresh][warn]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fetch with a hard timeout so a slow endpoint can never hang the whole run.
function fetchT(url, opts = {}, ms = 25000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

/* ---------- 1. fetch + normalise every feed (fail soft) ---------- */
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

// Hacker News front page via Algolia — keep only AI-ish titles.
const AI_RE = /\b(ai|llm|gpt|genai|machine learning|ml|neural|model|openai|anthropic|deepmind|gemini|claude|llama|mistral|diffusion|transformer|agent|inference|fine-tun)/i;
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
    }))
    .filter(s => AI_RE.test(s.headline));
}

async function fetchAll() {
  const out = [];
  for (const feed of FEEDS) {
    try {
      const items = feed.kind === 'hn' ? await fetchHn(feed) : await fetchRss(feed);
      log(`${feed.name}: ${items.length} items`);
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
{"summary": string, "category": "Models"|"Research"|"Funding"|"Tools"|"Policy"|"Other"}
Rules:
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
    if (!obj.summary) return null;
    if (!CATEGORIES.includes(obj.category)) obj.category = 'Other';
    return { summary: String(obj.summary).trim(), category: obj.category };
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
    // One short retry for a transient per-minute limit; cap the wait so a
    // genuinely-exhausted daily quota can't stall the run. Then fall through.
    if (allowRetry && wait != null && wait <= 30) {
      warn(`gemini 429, retrying in ${wait}s`);
      await sleep(wait * 1000);
      return summariseGemini(story, { allowRetry: false });
    }
    throw Object.assign(new Error(`gemini rate limit — ${body}`), { rateLimited: true });
  }
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

async function summarise(story) {
  if (GEMINI_API_KEY) {
    try {
      return await summariseGemini(story);
    } catch (err) {
      if (!GROQ_API_KEY) throw err;        // no fallback configured — surface it
      warn(`gemini failed (${err.message.slice(0, 140)}); trying groq`);
      return await summariseGroq(story);
    }
  }
  return await summariseGroq(story);        // Groq-only setup
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

async function main() {
  if (!GEMINI_API_KEY && !GROQ_API_KEY) {
    console.error('No GEMINI_API_KEY or GROQ_API_KEY set. Aborting.');
    process.exit(1);
  }

  const existing = await loadExisting();
  const existingIds = new Set(existing.map(c => c.id));

  const all = dedupe(await fetchAll());
  const fresh = all.filter(s => !existingIds.has(s.id)).slice(0, MAX_NEW_PER_RUN);
  log(`fetched ${all.length} unique, ${fresh.length} new to summarise`);

  const newCards = [];
  let consecutiveFails = 0;
  for (const story of fresh) {
    try {
      const { summary, category } = await summarise(story);
      consecutiveFails = 0;
      newCards.push({
        id: story.id,
        category,
        headline: story.headline,
        summary,
        source: story.source,
        url: story.url,
        published: new Date(story.published).toISOString(),
      });
      log(`+ [${category}] ${story.headline.slice(0, 60)}`);
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
    await sleep(THROTTLE_MS);
  }

  if (!newCards.length) {
    log('no new cards this run — leaving cards.json unchanged');
    return;
  }

  const merged = [...newCards, ...existing]
    .sort((a, b) => new Date(b.published) - new Date(a.published))
    .slice(0, MAX_CARDS);

  await writeFile(CARDS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  log(`wrote ${merged.length} cards (${newCards.length} new)`);
}

main().catch(err => { console.error('[refresh] fatal:', err); process.exit(1); });
