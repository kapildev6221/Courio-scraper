/**
 * Search layer — Tavily (AI-native) + Google CSE in parallel.
 * Tavily returns pre-extracted content + a direct answer.
 * Google CSE adds breadth. Results are merged and deduplicated by URL.
 */

const { log } = require('./utils');
const cache = require('./cache');

const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_API_KEY || '';
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || '';

const SEARCH_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function tavilySearch(query, options = {}) {
  if (!TAVILY_KEY) return { answer: null, results: [] };

  const cacheKey = `tavily:${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        search_depth: options.depth || 'basic',
        max_results: options.maxResults || 5,
        include_answer: true,
        include_raw_content: false,
        include_images: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('warn', 'Tavily non-OK', { status: res.status, body: body.slice(0, 200), query });
      return { answer: null, results: [] };
    }

    const data = await res.json();
    const result = {
      answer: data.answer || null,
      results: (data.results || []).map(r => ({
        title: r.title || '',
        url: r.url || '',
        content: r.content || '',
        score: r.score || 0,
        source: 'tavily',
      })),
    };

    cache.set(cacheKey, result, SEARCH_CACHE_TTL);
    log('info', 'Tavily search done', { query, results: result.results.length, hasAnswer: !!result.answer });
    return result;
  } catch (err) {
    log('warn', 'Tavily search error', { query, error: err.message });
    return { answer: null, results: [] };
  }
}

async function googleSearch(query, options = {}) {
  if (!GOOGLE_CSE_KEY || !GOOGLE_CSE_ID) return [];

  const cacheKey = `google:${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const q = encodeURIComponent(query);
    const url = `https://www.googleapis.com/customsearch/v1?q=${q}&key=${GOOGLE_CSE_KEY}&cx=${GOOGLE_CSE_ID}&num=${options.num || 5}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      log('warn', 'Google CSE non-OK', { status: res.status, query });
      return [];
    }

    const data = await res.json();
    const results = (data.items || []).map(item => ({
      title: item.title || '',
      url: item.link || '',
      content: item.snippet || '',
      displayLink: item.displayLink || '',
      source: 'google',
    }));

    cache.set(cacheKey, results, SEARCH_CACHE_TTL);
    log('info', 'Google CSE done', { query, results: results.length });
    return results;
  } catch (err) {
    log('warn', 'Google CSE error', { query, error: err.message });
    return [];
  }
}

/**
 * Unified search: Tavily + Google CSE in parallel.
 * Returns { answer, results } — Tavily results ranked first.
 */
async function search(query, options = {}) {
  const [tavily, google] = await Promise.all([
    tavilySearch(query, options),
    googleSearch(query, options),
  ]);

  const tavilyResults = tavily.results || [];
  const googleResults = Array.isArray(google) ? google : [];

  // Merge, dedup by URL — Tavily first (higher quality + AI-extracted content)
  const seen = new Set();
  const merged = [];

  for (const r of tavilyResults) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url);
      merged.push(r);
    }
  }
  for (const r of googleResults) {
    if (r.url && !seen.has(r.url)) {
      seen.add(r.url);
      merged.push(r);
    }
  }

  return {
    answer: tavily.answer || null,
    results: merged.slice(0, 8),
  };
}

module.exports = { search, tavilySearch, googleSearch };
