// Feed sources — a single config array so adding/dropping a source is a one-line change.
// `kind` is "rss" for normal feeds, or "hn" for the Hacker News Algolia API (not RSS).
// IMPORTANT: verify each URL resolves before relying on it — feeds move.

export const FEEDS = [
  { name: 'TechCrunch',      kind: 'rss', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'The Verge',       kind: 'rss', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: 'Ars Technica',    kind: 'rss', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'VentureBeat',     kind: 'rss', url: 'https://venturebeat.com/category/ai/feed/' },
  { name: 'Google DeepMind', kind: 'rss', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'OpenAI',          kind: 'rss', url: 'https://openai.com/news/rss.xml' },
  // Anthropic has no public RSS feed at a standard path (all 404 as of 2026-06).
  // Re-enable this line if/when they publish one:
  // { name: 'Anthropic',    kind: 'rss', url: 'https://www.anthropic.com/news/rss.xml' },
  { name: 'arXiv cs.AI',     kind: 'rss', url: 'https://rss.arxiv.org/rss/cs.AI' },
  { name: 'arXiv cs.LG',     kind: 'rss', url: 'https://rss.arxiv.org/rss/cs.LG' },
  // Hacker News front page — Algolia API, filtered to AI-ish stories in the script.
  { name: 'Hacker News',     kind: 'hn',  url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40' },
];

export const CATEGORIES = ['Models', 'Research', 'Funding', 'Tools', 'Policy', 'Other'];

// How many cards.json keeps (newest first), and how many new stories to summarise per run.
export const MAX_CARDS = 50;
export const MAX_NEW_PER_RUN = 30;
