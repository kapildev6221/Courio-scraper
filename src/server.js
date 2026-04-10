const express = require('express');
const { setupMiddleware, validateScrapeBody, validateMultiBody } = require('./middleware');
const { scrapePage, scrapeMultiple } = require('./scraper');
const { launchBrowser, getStats, shutdown } = require('./browser');
const { search } = require('./search');
const { readUrl } = require('./reader');
const { answerFromContent } = require('./ai');
const { research, priceCheck } = require('./research');
const cache = require('./cache');
const { log } = require('./utils');

const app = express();
const PORT = process.env.PORT || 3001;
const startedAt = Date.now();

setupMiddleware(app);

// ── Health ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const stats = getStats();
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    activeTabs: stats.activeTabs,
    totalScrapes: stats.totalScrapes,
    successRate: stats.successRate,
    browserConnected: stats.connected,
    cache: cache.stats(),
  });
});

// ── Search — Tavily + Google CSE parallel ───────────────────────────────
app.post('/search', async (req, res) => {
  const { query, maxResults, depth } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ success: false, error: 'query is required and must be a string' });
  }

  try {
    const result = await search(query.trim(), { maxResults: maxResults || 5, depth: depth || 'basic' });
    res.json({ success: true, ...result });
  } catch (err) {
    log('error', 'Search endpoint error', { error: err.message });
    res.status(500).json({ success: false, error: 'search_failed', details: err.message });
  }
});

// ── Read — Jina → Puppeteer fallback ────────────────────────────────────
app.post('/read', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.status(400).json({ success: false, error: 'url must be a valid http(s) URL' });
  }

  try {
    const content = await readUrl(url);
    if (!content) {
      return res.json({ success: false, error: 'no_content', details: 'Could not extract readable content from this URL' });
    }
    res.json({ success: true, url, content, length: content.length });
  } catch (err) {
    log('error', 'Read endpoint error', { error: err.message, url });
    res.status(500).json({ success: false, error: 'read_failed', details: err.message });
  }
});

// ── Extract — read a URL and answer a question with Sonnet ───────────────
app.post('/extract', async (req, res) => {
  const { url, question } = req.body;

  if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.status(400).json({ success: false, error: 'url must be a valid http(s) URL' });
  }
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ success: false, error: 'question is required and must be a string' });
  }

  try {
    const content = await readUrl(url);
    if (!content) {
      return res.json({ success: false, error: 'no_content', details: 'Could not read this URL' });
    }

    const answer = await answerFromContent(url, question.trim(), content);
    res.json({ success: true, url, question, answer, contentLength: content.length });
  } catch (err) {
    log('error', 'Extract endpoint error', { error: err.message, url });
    res.status(500).json({ success: false, error: 'extract_failed', details: err.message });
  }
});

// ── Research — full pipeline: search → read → Sonnet synthesis ──────────
app.post('/research', async (req, res) => {
  const { query, context } = req.body;

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ success: false, error: 'query is required and must be a string' });
  }

  try {
    const result = await research(query.trim(), { context: context || '' });
    res.json({ success: true, ...result });
  } catch (err) {
    log('error', 'Research endpoint error', { error: err.message });
    res.status(500).json({ success: false, error: 'research_failed', details: err.message });
  }
});

// ── Price check — items → structured prices JSON ─────────────────────────
app.post('/price-check', async (req, res) => {
  const { items, location } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'items must be a non-empty array of strings' });
  }
  if (items.length > 10) {
    return res.status(400).json({ success: false, error: 'Maximum 10 items per request' });
  }

  try {
    const result = await priceCheck(items, location || 'Winnipeg');
    res.json({ success: true, items: result, count: result.length });
  } catch (err) {
    log('error', 'Price check endpoint error', { error: err.message });
    res.status(500).json({ success: false, error: 'price_check_failed', details: err.message });
  }
});

// ── Legacy: single scrape ────────────────────────────────────────────────
app.post('/scrape', validateScrapeBody, async (req, res) => {
  try {
    const result = await scrapePage(req.body);
    res.json(result);
  } catch (err) {
    log('error', 'Scrape endpoint error', { error: err.message, url: req.body.url });

    const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout');
    const isBlocked = err.statusCode === 403 || err.statusCode === 429;

    res.status(isBlocked ? 403 : 500).json({
      success: false,
      error: isTimeout ? 'timeout' : isBlocked ? 'blocked' : 'scrape_failed',
      details: err.message,
      url: req.body.url,
      retries: 3,
    });
  }
});

// ── Legacy: multi scrape ─────────────────────────────────────────────────
app.post('/scrape-multi', validateMultiBody, async (req, res) => {
  try {
    const result = await scrapeMultiple(req.body.targets);
    res.json(result);
  } catch (err) {
    log('error', 'Multi-scrape endpoint error', { error: err.message });
    res.status(500).json({ success: false, error: 'multi_scrape_failed', details: err.message });
  }
});

// ── 404 ──────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// ── Global error handler ─────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  log('error', 'Unhandled express error', { error: err.message });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Never crash ──────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection', { error: String(reason) });
});

// ── Graceful shutdown ────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  log('info', 'Shutdown signal received', { signal });
  await shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Start ────────────────────────────────────────────────────────────────
(async () => {
  try {
    await launchBrowser();
    app.listen(PORT, '0.0.0.0', () => {
      log('info', 'Courio Scraper service started', {
        port: PORT,
        endpoints: ['/health', '/search', '/read', '/extract', '/research', '/price-check', '/scrape', '/scrape-multi'],
      });
    });
  } catch (err) {
    log('error', 'Failed to start server', { error: err.message });
    process.exit(1);
  }
})();
