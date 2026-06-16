/* ============================================================
   NewinAI — app.js
   Renders cards.json into a scroll-snap feed, drives progress,
   first-run hint, share, theme, and online/offline states.
   No framework. No build step.
   ============================================================ */

'use strict';

/* ---------- category → accent + texture (HANDOFF §3) ---------- */
const CATEGORIES = {
  Models:   { accent: '#5B8CFF', accentLight: '#5B8CFF', pattern: 'dots' },
  Research: { accent: '#B07CFF', accentLight: '#B07CFF', pattern: 'rings' },
  Funding:  { accent: '#3DE0A0', accentLight: '#3DE0A0', pattern: 'bars' },
  Tools:    { accent: '#FFB454', accentLight: '#E08A1E', pattern: 'mesh' },
  Policy:   { accent: '#FF6B6B', accentLight: '#FF6B6B', pattern: 'stripes' },
  Other:    { accent: '#8A8AA0', accentLight: '#6A6A80', pattern: 'dots' },
};
const FALLBACK = CATEGORIES.Other;

/* ---------- small helpers ---------- */
function hexToRgb(hex) {
  const h = (hex || '#5B8CFF').replace('#', '');
  const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(f, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',');
}
function pad(n) { return String(n).padStart(2, '0'); }

// relative age from an ISO timestamp (HANDOFF §2)
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (!isFinite(s) || s < 0) return 'just now';
  if (s < 3600)  return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// generated geometric texture for a category accent (HANDOFF §4)
function textureLayer(pattern, rgb) {
  const c = (a) => `rgba(${rgb},${a})`;
  switch (pattern) {
    case 'dots':    return `radial-gradient(circle, ${c(.14)} 1.6px, transparent 1.7px) 0 0 / 23px 23px`;
    case 'rings':   return `repeating-radial-gradient(circle at 78% 115%, transparent 0 27px, ${c(.075)} 27px 29px)`;
    case 'bars':    return `repeating-linear-gradient(90deg, ${c(.09)} 0 2px, transparent 2px 16px)`;
    case 'mesh':    return `linear-gradient(${c(.07)} 1px, transparent 1px) 0 0 / 28px 28px, linear-gradient(90deg, ${c(.07)} 1px, transparent 1px) 0 0 / 28px 28px`;
    case 'stripes': return `repeating-linear-gradient(48deg, ${c(.07)} 0 2px, transparent 2px 18px)`;
    default:        return 'none';
  }
}

// full card background: glow(s) + texture + base (HANDOFF §4)
function cardBackground(rgb, pattern, isLight) {
  const base  = isLight ? '#EDEDF0' : '#0A0A0C';
  const glowA = `radial-gradient(118% 78% at 100% -8%, rgba(${rgb},${isLight ? .18 : .24}) 0%, transparent 56%)`;
  const glowB = `radial-gradient(95% 65% at -12% 112%, rgba(${rgb},${isLight ? .10 : .15}) 0%, transparent 55%)`;
  return `${glowA}, ${glowB}, ${textureLayer(pattern, rgb)}, ${base}`;
}

// bottom scrim for image cards (HANDOFF §4)
function imageScrim(rgb) {
  return `linear-gradient(to top, rgba(7,7,10,.92) 6%, rgba(7,7,10,.55) 38%, rgba(7,7,10,.12) 70%, rgba(${rgb},.18) 100%)`;
}

function headlineClass(text) {
  const len = (text || '').length;
  if (len > 62) return 'hl-sm';
  if (len > 34) return 'hl-md';
  return '';
}

/* ---------- state ---------- */
const feed = document.getElementById('feed');
const cardTpl = document.getElementById('card-tpl');
const skeletonTpl = document.getElementById('skeleton-tpl');
const endTpl = document.getElementById('end-tpl');

let stories = [];

/* ---------- theme ---------- */
function isLight() { return document.documentElement.getAttribute('data-theme') === 'light'; }

function accentFor(category) {
  const cat = CATEGORIES[category] || FALLBACK;
  return isLight() ? cat.accentLight : cat.accent;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#EDEDF0' : '#0A0A0C');
  try { localStorage.setItem('newinai.theme', theme); } catch (_) {}
  // repaint every card so accents/glows track the theme
  document.querySelectorAll('.card[data-category]').forEach(repaintCard);
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(isLight() ? 'dark' : 'light');
});

/* ---------- card painting ---------- */
function repaintCard(cardEl) {
  const category = cardEl.dataset.category;
  const pattern  = cardEl.dataset.pattern;
  const accent   = accentFor(category);
  const rgb      = hexToRgb(accent);
  const hasImage = cardEl.classList.contains('card--has-image');

  cardEl.style.setProperty('--accent', accent);
  cardEl.style.setProperty('--accent-rgb', rgb);
  cardEl.style.setProperty('--accent-soft', `rgba(${rgb},.08)`);
  cardEl.style.setProperty('--accent-soft-22', `rgba(${rgb},.22)`);

  const bg = cardEl.querySelector('.card-bg');
  if (bg) bg.style.background = cardBackground(rgb, pattern, isLight());

  const scrim = cardEl.querySelector('.card-scrim');
  if (scrim && hasImage) scrim.style.background = imageScrim(rgb);

  // active progress segment glow uses the accent too
  cardEl.querySelectorAll('.seg.filled').forEach(s => {
    s.style.background = accent;
  });
}

function buildCard(story, index, total) {
  const node = cardTpl.content.firstElementChild.cloneNode(true);
  const cat = CATEGORIES[story.category] || FALLBACK;

  node.dataset.index = index;
  node.dataset.category = story.category in CATEGORIES ? story.category : 'Other';
  node.dataset.pattern = cat.pattern;
  if (index === 1) node.classList.add('card--first');

  // image
  if (story.image) {
    node.classList.add('card--has-image');
    const wrap = node.querySelector('.card-img-wrap');
    const img = node.querySelector('.card-img');
    wrap.hidden = false;
    img.src = story.image;
    img.alt = story.headline || '';
    // if the image fails, drop back to the textured background
    img.addEventListener('error', () => {
      node.classList.remove('card--has-image');
      wrap.hidden = true;
    });
  }

  // tag + counter
  node.querySelector('.tag').textContent = story.category || 'Other';
  node.querySelector('.counter').textContent = `${pad(index)} / ${pad(total)}`;

  // headline (auto-sized)
  const h = node.querySelector('.headline');
  h.textContent = story.headline || '';
  const hc = headlineClass(story.headline);
  if (hc) h.classList.add(hc);

  // summary
  node.querySelector('.summary').textContent = story.summary || '';

  // source · age
  const src = node.querySelector('.source');
  src.innerHTML = `${escapeHtml(story.source || '')} <span style="opacity:.5;margin:0 6px;">&middot;</span> ${ago(story.published)}`;

  // read button
  const read = node.querySelector('.read-btn');
  read.href = story.url || '#';

  // share
  node.querySelector('.share-btn').addEventListener('click', () => openShare(story));

  // progress segments
  const prog = node.querySelector('.progress');
  for (let i = 1; i <= total; i++) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    if (i <= index) seg.classList.add('filled');
    if (i === index) seg.classList.add('active');
    prog.appendChild(seg);
  }

  // first-card swipe hint (quiet, always-on)
  if (index === 1) node.querySelector('.swipe-hint').hidden = false;

  repaintCard(node);
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ---------- render ----------
   Each card carries its own counter + progress segments (baked in buildCard),
   so position is correct per card with no scroll listener needed — the only
   visible card IS the active one. */
function renderFeed(data) {
  stories = Array.isArray(data) ? data : [];
  feed.innerHTML = '';

  if (!stories.length) {
    feed.appendChild(endCard(true));
    return;
  }

  const total = stories.length;
  stories.forEach((story, i) => feed.appendChild(buildCard(story, i + 1, total)));
  feed.appendChild(endCard());

  maybeShowNudge();
}

function endCard(empty) {
  const node = endTpl.content.firstElementChild.cloneNode(true);
  const n = stories.length;
  node.querySelector('.state-body').textContent = empty
    ? "No stories yet — fresh ones land through the day. Check back later."
    : `You've read all ${n} stories. Fresh ones land through the day — check back later.`;
  node.querySelector('.state-meta').textContent = empty ? '0 READ TODAY' : `${n} READ TODAY`;
  node.querySelector('.back-to-top').addEventListener('click', () => {
    feed.scrollTo({ top: 0, behavior: 'smooth' });
  });
  return node;
}

function showSkeletons(count = 1) {
  feed.innerHTML = '';
  for (let i = 0; i < count; i++) {
    feed.appendChild(skeletonTpl.content.firstElementChild.cloneNode(true));
  }
}

/* ---------- first-run nudge (once per device) ---------- */
function maybeShowNudge() {
  let seen = false;
  try { seen = localStorage.getItem('newinai.seenHint') === '1'; } catch (_) {}
  if (seen) return;
  const nudge = document.getElementById('nudge');
  nudge.hidden = false;
  document.getElementById('nudge-got-it').addEventListener('click', () => {
    nudge.hidden = true;
    try { localStorage.setItem('newinai.seenHint', '1'); } catch (_) {}
  }, { once: true });
}

/* ---------- share ---------- */
const shareOverlay = document.getElementById('share');
let shareStory = null;

function openShare(story) {
  shareStory = story;
  const accent = accentFor(story.category);
  const rgb = hexToRgb(accent);
  const cat = CATEGORIES[story.category] || FALLBACK;

  const card = document.getElementById('share-card');
  card.style.background = `${cardBackground(rgb, cat.pattern, false)}`;
  card.style.setProperty('--accent', accent);
  card.style.setProperty('--accent-soft-22', `rgba(${rgb},.22)`);

  document.getElementById('share-tag').textContent = story.category || 'Other';
  document.getElementById('share-tag').style.background = accent;
  document.getElementById('share-headline').textContent = story.headline || '';
  document.getElementById('share-meta').textContent = `${story.source || ''} · ${ago(story.published)}`;

  // accent tile
  document.querySelector('.share-tile--accent').style.background = `rgba(${rgb},.22)`;

  shareOverlay.hidden = false;
}

function closeShare() { shareOverlay.hidden = true; }

shareOverlay.addEventListener('click', (e) => {
  if (e.target === shareOverlay) closeShare();
});

document.querySelectorAll('.share-opt').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (!shareStory) return;
    const action = btn.dataset.action;
    const url = shareStory.url || location.href;
    const title = shareStory.headline || 'NewinAI';

    if (action === 'copy') {
      await copyText(url);
      toast('Link copied');
      closeShare();
    } else if (action === 'message' || action === 'more') {
      if (navigator.share) {
        try { await navigator.share({ title, text: title, url }); } catch (_) {}
        closeShare();
      } else {
        await copyText(url);
        toast('Link copied');
        closeShare();
      }
    } else if (action === 'image') {
      // v1: native share of the link (image export is a later enhancement)
      if (navigator.share) {
        try { await navigator.share({ title, url }); } catch (_) {}
      } else {
        await copyText(url);
        toast('Link copied');
      }
      closeShare();
    }
  });
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ---------- online / offline ---------- */
const offlineOverlay = document.getElementById('offline');
let lastSynced = null;

function showOffline() {
  const synced = document.getElementById('offline-synced');
  synced.textContent = lastSynced
    ? `LAST SYNCED ${ago(lastSynced).toUpperCase()}`
    : 'NOT YET SYNCED';
  offlineOverlay.hidden = false;
}
function hideOffline() { offlineOverlay.hidden = true; }

document.getElementById('offline-retry').addEventListener('click', () => {
  hideOffline();
  load();
});
window.addEventListener('online', () => { hideOffline(); load(); });
window.addEventListener('offline', showOffline);

/* ---------- load ----------
   Cards are served from the GitHub-hosted copy (raw CDN), not from the Netlify
   build, so the cron's data refreshes never trigger a (paid) Netlify deploy.
   Falls back to the copy bundled with the site if GitHub is unreachable. */
const REMOTE_CARDS = 'https://raw.githubusercontent.com/lakshminarasi-arch/NewinAI/main/cards.json';
const LOCAL_CARDS = 'cards.json';

async function fetchCards() {
  for (const url of [REMOTE_CARDS, LOCAL_CARDS]) {
    try {
      const res = await fetch(`${url}?ts=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (_) { /* try the next source */ }
  }
  throw new Error('could not load cards from GitHub or local copy');
}

async function load() {
  // preserve reading position across reloads
  const prevScroll = feed.scrollTop;

  if (!navigator.onLine) { showOffline(); return; }

  if (!stories.length) showSkeletons(1);

  try {
    const data = await fetchCards();
    lastSynced = new Date().toISOString();
    renderFeed(data);
    // restore scroll position if we were already reading
    if (prevScroll > 0) feed.scrollTop = prevScroll;
  } catch (err) {
    console.error('[NewinAI] load failed:', err);
    if (!stories.length) showOffline();
    else toast('Could not refresh');
  }
}

/* ---------- boot ---------- */
(function init() {
  let saved = 'dark';
  try { saved = localStorage.getItem('newinai.theme') || 'dark'; } catch (_) {}
  document.documentElement.setAttribute('data-theme', saved);
  load();
})();
