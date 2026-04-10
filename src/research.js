/**
 * Research pipeline — the core of Kay's internet intelligence.
 *
 * /research flow:
 *   1. Search (Tavily + Google CSE in parallel)
 *   2. Read top pages (Jina → Puppeteer fallback, parallel)
 *   3. Synthesize with Sonnet → single authoritative answer
 *
 * /price-check flow:
 *   Same pipeline but returns structured item/price JSON.
 */

const { log } = require('./utils');
const { search } = require('./search');
const { readUrl } = require('./reader');
const { synthesizeResearch, extractFromContent } = require('./ai');
const cache = require('./cache');

const RESEARCH_CACHE_TTL = 10 * 60 * 1000; // 10 min
const PRICE_CACHE_TTL   =  5 * 60 * 1000; //  5 min — prices change faster
const MAX_PAGES_TO_READ = 3;

/**
 * Full research pipeline.
 * Returns { answer, sources, totalMs, fromCache }
 */
async function research(query, options = {}) {
  const normalizedKey = `research:${query.toLowerCase().trim().slice(0, 150)}`;
  const cached = cache.get(normalizedKey);
  if (cached) {
    log('info', 'Research cache hit', { query });
    return { ...cached, fromCache: true };
  }

  const startTime = Date.now();
  log('info', 'Research pipeline starting', { query });

  // Step 1: Search
  const searchData = await search(query, { maxResults: 5, depth: 'basic' });
  const tavilyAnswer = searchData.answer; // May be null if Tavily key missing

  // Pick top URLs to read — skip search engine homepages
  const topResults = (searchData.results || [])
    .filter(r => r.url && !/^https?:\/\/(www\.)?(google|bing|yahoo)\.(com|ca)/.test(r.url))
    .slice(0, MAX_PAGES_TO_READ);

  log('info', 'Research search done', {
    query,
    resultCount: topResults.length,
    hasTavilyAnswer: !!tavilyAnswer,
  });

  // Step 2: Read pages in parallel
  const pageContents = await Promise.all(
    topResults.map(async r => {
      const content = await readUrl(r.url);
      return {
        url: r.url,
        title: r.title || '',
        content: content || r.content || '', // fall back to search snippet
      };
    })
  );

  // Build sources list — Tavily answer first, then pages, then unused snippets
  const sources = [];

  if (tavilyAnswer) {
    sources.push({ url: 'Tavily AI', title: 'Direct Answer', content: tavilyAnswer });
  }

  for (const p of pageContents) {
    if (p.content && p.content.length > 50) sources.push(p);
  }

  // Fill remaining slots with search snippets not yet included
  for (const r of searchData.results || []) {
    if (sources.length >= 6) break;
    if (!sources.find(s => s.url === r.url) && r.content) {
      sources.push({ url: r.url, title: r.title, content: r.content });
    }
  }

  if (sources.length === 0) {
    log('warn', 'Research found no usable content', { query });
    return { answer: null, sources: [], totalMs: Date.now() - startTime, fromCache: false };
  }

  // Step 3: Synthesize with Sonnet
  const answer = await synthesizeResearch(query, sources, options.context || '');

  const result = {
    answer,
    sources: sources.map(s => ({ url: s.url, title: s.title })),
    totalMs: Date.now() - startTime,
  };

  cache.set(normalizedKey, result, RESEARCH_CACHE_TTL);

  log('info', 'Research pipeline complete', {
    query,
    totalMs: result.totalMs,
    sourceCount: sources.length,
    answerLength: answer?.length || 0,
  });

  return { ...result, fromCache: false };
}

/**
 * Price check pipeline.
 * Returns array of { name, price, unit, store, onSale, inStock }
 */
async function priceCheck(items, location = 'Winnipeg') {
  if (!items || items.length === 0) return [];

  const query = `current price of ${items.slice(0, 5).join(', ')} at grocery stores in ${location} 2025`;
  const cacheKey = `price:${query.slice(0, 150)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const startTime = Date.now();

  const searchData = await search(query, { maxResults: 5 });

  // Read top 2 pages
  const topUrls = (searchData.results || [])
    .filter(r => r.url)
    .slice(0, 2);

  const pages = await Promise.all(
    topUrls.map(async r => {
      const content = await readUrl(r.url);
      return { url: r.url, content: content || r.content || '' };
    })
  );

  const allContent = [
    searchData.answer || '',
    ...pages.map(p => p.content),
    ...(searchData.results || []).map(r => r.content),
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 12000);

  if (!allContent.trim()) return [];

  const schema = {
    items: [
      {
        name: 'string — product name',
        price: 'string — like $4.99',
        unit: 'string — like per lb, each, 2L, 900g',
        store: 'string — store name',
        onSale: 'boolean',
        salePrice: 'string or null',
        inStock: 'boolean',
      },
    ],
  };

  const extracted = await extractFromContent(
    `Current prices for ${items.join(', ')} at grocery stores in ${location}`,
    allContent,
    schema
  );

  const result = (extracted?.items || [])
    .filter(i => i && typeof i.name === 'string' && typeof i.price === 'string')
    .map(i => ({
      name: i.name.slice(0, 200),
      price: i.price.slice(0, 20),
      unit: (i.unit || 'each').slice(0, 30),
      store: (i.store || 'Unknown').slice(0, 100),
      onSale: i.onSale === true,
      salePrice: i.salePrice || null,
      inStock: i.inStock !== false,
    }));

  cache.set(cacheKey, result, PRICE_CACHE_TTL);

  log('info', 'Price check complete', {
    items: items.length,
    found: result.length,
    totalMs: Date.now() - startTime,
  });

  return result;
}

module.exports = { research, priceCheck };
