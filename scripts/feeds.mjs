// Feed sources — a single config array so adding/dropping a source is a one-line change.
// `kind`   : "rss" for normal feeds, or "hn" for the Hacker News Algolia API (not RSS).
// `aiOnly` : true for feeds that are already AI-only (AI sections, AI labs, arXiv AI lists).
//            false for broad/general feeds — those get a keyword pre-filter in the script
//            so non-AI stories (space, cars, sport…) never reach the summariser.
// `cap`    : optional. Keep at most this many (newest) items from the feed per run, so a
//            high-volume source (e.g. arXiv) can't drown out the news feeds.
// IMPORTANT: verify each URL resolves before relying on it — feeds move.

export const FEEDS = [
  { name: 'TechCrunch',      kind: 'rss', aiOnly: true,  url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'The Verge',       kind: 'rss', aiOnly: true,  url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  // Ars Technica publishes no AI-only feed — this is the whole site, so it's filtered.
  { name: 'Ars Technica',    kind: 'rss', aiOnly: false, url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'VentureBeat',     kind: 'rss', aiOnly: true,  url: 'https://venturebeat.com/category/ai/feed/' },
  { name: 'Google DeepMind', kind: 'rss', aiOnly: true,  url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'OpenAI',          kind: 'rss', aiOnly: true,  url: 'https://openai.com/news/rss.xml' },
  // Anthropic has no public RSS feed at a standard path (all 404 as of 2026-06).
  // Re-enable this line if/when they publish one:
  // { name: 'Anthropic',    kind: 'rss', aiOnly: true,  url: 'https://www.anthropic.com/news/rss.xml' },
  // arXiv is high-volume and dense — cap intake hard so research preprints don't dominate.
  { name: 'arXiv cs.AI',     kind: 'rss', aiOnly: true,  cap: 2, url: 'https://rss.arxiv.org/rss/cs.AI' },
  { name: 'arXiv cs.LG',     kind: 'rss', aiOnly: true,  cap: 2, url: 'https://rss.arxiv.org/rss/cs.LG' },
  // Hacker News front page — Algolia API; broad, so keyword-filtered like Ars.
  { name: 'Hacker News',     kind: 'hn',  aiOnly: false, url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=40' },
];

export const CATEGORIES = ['Models', 'Research', 'Funding', 'Tools', 'Policy', 'Other'];

// How many cards.json keeps (newest first), and how many new stories to summarise per run.
export const MAX_CARDS = 50;
export const MAX_NEW_PER_RUN = 30;
// Hard ceiling on arXiv (research-preprint) cards in the final feed, regardless of how
// many arrive. News is high-signal and low-volume; arXiv is the opposite — this keeps
// the feed news-led with only a handful of the freshest papers.
export const MAX_ARXIV_CARDS = 5;
