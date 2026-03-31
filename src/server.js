const express = require('express');
const { setupMiddleware, validateScrapeBody, validateMultiBody } = require('./middleware');
const { scrapePage, scrapeMultiple } = require('./scraper');
const { launchBrowser, getStats, shutdown } = require('./browser');
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
  });
});

// ── Single scrape ───────────────────────────────────────────────────────
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

// ── Multi scrape ────────────────────────────────────────────────────────
app.post('/scrape-multi', validateMultiBody, async (req, res) => {
  try {
    const result = await scrapeMultiple(req.body.targets);
    res.json(result);
  } catch (err) {
    log('error', 'Multi-scrape endpoint error', { error: err.message });
    res.status(500).json({
      success: false,
      error: 'multi_scrape_failed',
      details: err.message,
    });
  }
});

// ── 404 ─────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// ── Global error handler ────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  log('error', 'Unhandled express error', { error: err.message });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Never crash ─────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection', { error: String(reason) });
});

// ── Graceful shutdown ───────────────────────────────────────────────────
async function gracefulShutdown(signal) {
  log('info', 'Shutdown signal received', { signal });
  await shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Start ───────────────────────────────────────────────────────────────
(async () => {
  try {
    await launchBrowser();
    app.listen(PORT, '0.0.0.0', () => {
      log('info', 'Scraper service started', { port: PORT });
    });
  } catch (err) {
    log('error', 'Failed to start server', { error: err.message });
    process.exit(1);
  }
})();
