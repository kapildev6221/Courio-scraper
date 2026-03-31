const { createContext, closeContext, recordSuccess } = require('./browser');
const { log, randomDelay, randomUserAgent, withRetry } = require('./utils');

async function scrapePage(target) {
  const { url, selectors, waitFor, scrollFirst, clickFirst, jsEnabled, loadResources } = target;
  const startTime = Date.now();
  let retries = 0;

  const result = await withRetry(
    async (attempt) => {
      retries = attempt;
      const ua = randomUserAgent();
      const timeout = attempt === 0 ? 15000 : attempt === 1 ? 20000 : 30000;

      const { context, page } = await createContext({ userAgent: ua, jsEnabled, loadResources });

      try {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout,
        });

        const status = response?.status();
        if (status === 403 || status === 429) {
          const err = new Error(`Site returned ${status}`);
          err.statusCode = status;
          throw err;
        }

        await randomDelay(300, 600);

        if (waitFor) {
          try {
            await page.waitForSelector(waitFor, { timeout: 10000 });
          } catch (_) {
            try {
              await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
            } catch (_) {
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        } else {
          try {
            await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
          } catch (_) {}
        }

        if (clickFirst) {
          try {
            await page.waitForSelector(clickFirst, { timeout: 3000 });
            await randomDelay(200, 400);
            await page.click(clickFirst);
            await randomDelay(500, 1000);
          } catch (_) {
            log('warn', 'clickFirst selector not found', { selector: clickFirst, url });
          }
        }

        if (scrollFirst) {
          await autoScroll(page);
        }

        await randomDelay(200, 500);

        const data = await page.evaluate((sels) => {
          const result = {};
          for (const [key, selector] of Object.entries(sels)) {
            const el = document.querySelector(selector);
            if (!el) {
              result[key] = null;
              continue;
            }
            let value = el.textContent?.trim();
            if (!value) value = el.innerText?.trim();
            if (!value) value = el.getAttribute('content') || el.getAttribute('value') || null;
            result[key] = value || null;
          }
          return result;
        }, selectors);

        recordSuccess();
        return data;
      } finally {
        await closeContext(context);
      }
    },
    {
      maxRetries: 3,
      onRetry: (attempt, err) => {
        log('warn', 'Scrape retry', { url, attempt, error: err.message });
      },
    }
  );

  const responseTimeMs = Date.now() - startTime;
  log('info', 'Scrape completed', { url, success: true, responseTimeMs, retries });

  return {
    success: true,
    data: result,
    scrapedAt: new Date().toISOString(),
    responseTimeMs,
    retries,
  };
}

async function scrapeMultiple(targets) {
  const startTime = Date.now();
  const BATCH_SIZE = 3;
  const results = [];

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (target) => {
        try {
          const result = await scrapePage(target);
          return { url: target.url, ...result };
        } catch (err) {
          log('error', 'Scrape failed', { url: target.url, error: err.message });
          return {
            url: target.url,
            success: false,
            error: err.message,
            responseTimeMs: Date.now() - startTime,
          };
        }
      })
    );
    results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : {
      success: false,
      error: r.reason?.message || 'Unknown error',
    }));
  }

  return {
    results,
    totalTimeMs: Date.now() - startTime,
  };
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
      setTimeout(() => { clearInterval(timer); resolve(); }, 10000);
    });
  });
  await randomDelay(500, 1000);
}

module.exports = { scrapePage, scrapeMultiple };
