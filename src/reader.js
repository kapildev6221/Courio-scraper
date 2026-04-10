/**
 * URL reader — converts any webpage to clean text.
 *
 * Strategy:
 * 1. Jina Reader (r.jina.ai) — free, no key, instant clean markdown
 * 2. Puppeteer fallback — for JS-heavy sites Jina can't handle
 *
 * Results cached 10 minutes to avoid re-fetching the same page.
 */

const { log } = require('./utils');
const cache = require('./cache');

const READ_CACHE_TTL = 10 * 60 * 1000;
const JINA_TIMEOUT_MS = 12000;
const PUPPETEER_TIMEOUT_MS = 18000;
const MAX_CONTENT_CHARS = 15000;

async function jinaRead(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);

    const res = await fetch(jinaUrl, {
      headers: {
        'Accept': 'text/plain',
        'User-Agent': 'Mozilla/5.0 (compatible; Courio/1.0)',
        'X-Return-Format': 'markdown',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      log('warn', 'Jina Reader non-OK', { url, status: res.status });
      return null;
    }

    const text = await res.text();
    if (!text || text.length < 100) return null;

    log('info', 'Jina read success', { url, length: text.length });
    return text.slice(0, MAX_CONTENT_CHARS);
  } catch (err) {
    log('warn', 'Jina Reader error', { url, error: err.message });
    return null;
  }
}

async function puppeteerRead(url) {
  const { createContext, closeContext } = require('./browser');
  let context = null;

  try {
    const { context: ctx, page } = await createContext({ loadResources: false });
    context = ctx;

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: PUPPETEER_TIMEOUT_MS,
    });

    const status = response?.status();
    if (status === 403 || status === 429) {
      log('warn', 'Puppeteer blocked', { url, status });
      return null;
    }

    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 });
    } catch (_) {}

    const text = await page.evaluate(() => {
      // Remove noise
      ['script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript', 'aside'].forEach(tag => {
        document.querySelectorAll(tag).forEach(el => el.remove());
      });

      // Try main content areas first
      const mainSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.main-content', '#main'];
      for (const sel of mainSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const t = (el.innerText || '').trim();
          if (t.length > 200) return t;
        }
      }

      return (document.body?.innerText || '').trim();
    });

    if (!text || text.length < 100) return null;

    log('info', 'Puppeteer read success', { url, length: text.length });
    return text.slice(0, MAX_CONTENT_CHARS);
  } catch (err) {
    log('warn', 'Puppeteer read error', { url, error: err.message });
    return null;
  } finally {
    if (context) {
      try { await context.close(); } catch (_) {}
    }
  }
}

/**
 * Read a URL — Jina first, Puppeteer fallback, cached.
 * Returns clean text string or null.
 */
async function readUrl(url) {
  const cacheKey = `read:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    log('info', 'Read cache hit', { url });
    return cached;
  }

  let content = await jinaRead(url);

  if (!content) {
    log('info', 'Jina failed — trying Puppeteer', { url });
    content = await puppeteerRead(url);
  }

  if (content) {
    cache.set(cacheKey, content, READ_CACHE_TTL);
  }

  return content;
}

module.exports = { readUrl, jinaRead, puppeteerRead };
