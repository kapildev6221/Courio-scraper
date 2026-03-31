const puppeteer = require('puppeteer');
const { log, BOT_USER_AGENT, VIEWPORT } = require('./utils');

const MAX_CONCURRENT_TABS = 5;
const RESTART_AFTER_REQUESTS = 50;

let browser = null;
let requestCount = 0;
let activeTabs = 0;
let totalScrapes = 0;
let successfulScrapes = 0;
let launching = false;
const queue = [];

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--window-size=1920,1080',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--no-default-browser-check',
];

async function launchBrowser() {
  if (launching) return;
  launching = true;

  try {
    if (browser) {
      try { await browser.close(); } catch (_) {}
      browser = null;
    }

    log('info', 'Launching browser');

    browser = await puppeteer.launch({
      headless: 'new',
      args: BROWSER_ARGS,
      protocolTimeout: 60000,
    });

    browser.on('disconnected', () => {
      log('warn', 'Browser disconnected — will relaunch on next request');
      browser = null;
    });

    requestCount = 0;
    log('info', 'Browser launched');
  } catch (err) {
    log('error', 'Browser launch failed', { error: err.message });
    browser = null;
    throw err;
  } finally {
    launching = false;
  }
}

async function ensureBrowser() {
  if (!browser || !browser.connected) {
    await launchBrowser();
  }
  if (requestCount >= RESTART_AFTER_REQUESTS) {
    log('info', 'Browser restart threshold reached', { requestCount });
    await launchBrowser();
  }
}

function processQueue() {
  while (queue.length > 0 && activeTabs < MAX_CONCURRENT_TABS) {
    const { resolve } = queue.shift();
    resolve();
  }
}

async function acquireTab() {
  if (activeTabs >= MAX_CONCURRENT_TABS) {
    await new Promise(resolve => queue.push({ resolve }));
  }
  activeTabs++;
}

function releaseTab() {
  activeTabs--;
  processQueue();
}

async function createContext(options = {}) {
  await ensureBrowser();
  await acquireTab();
  requestCount++;
  totalScrapes++;

  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  await page.setUserAgent(BOT_USER_AGENT);
  await page.setViewport(VIEWPORT);

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  });

  const loadResources = options.loadResources || false;
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (!loadResources && ['image', 'font', 'media', 'stylesheet'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  if (options.jsEnabled === false) {
    await page.setJavaScriptEnabled(false);
  }

  return { context, page };
}

async function closeContext(context) {
  try {
    await context.close();
  } catch (_) {}
  releaseTab();
}

function recordSuccess() {
  successfulScrapes++;
}

function getStats() {
  return {
    connected: browser?.connected || false,
    activeTabs,
    totalScrapes,
    successfulScrapes,
    successRate: totalScrapes > 0 ? +(successfulScrapes / totalScrapes * 100).toFixed(1) : 100,
    requestsSinceRestart: requestCount,
  };
}

async function shutdown() {
  log('info', 'Shutting down browser');
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
  }
}

module.exports = {
  launchBrowser,
  createContext,
  closeContext,
  recordSuccess,
  getStats,
  shutdown,
};
