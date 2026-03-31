const { createContext, closeContext, recordSuccess } = require('./browser');
const { log, randomDelay, withRetry, BOT_USER_AGENT } = require('./utils');

// ── robots.txt cache (24-hour TTL) ─────────────────────────────────────
const robotsCache = new Map(); // key: origin, value: { rules, fetchedAt }
const ROBOTS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

const RESPECT_ROBOTS = (process.env.RESPECT_ROBOTS || 'true') !== 'false';

async function fetchRobotsTxt(origin) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL) {
    return cached.rules;
  }

  const robotsUrl = `${origin}/robots.txt`;
  let rules = [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': BOT_USER_AGENT },
    });
    clearTimeout(timeout);

    if (res.ok) {
      const text = await res.text();
      rules = parseRobotsTxt(text);
      log('info', 'Fetched robots.txt', { origin, ruleCount: rules.length });
    } else {
      // No robots.txt or error — allow all
      log('info', 'No robots.txt found (allow all)', { origin, status: res.status });
    }
  } catch (err) {
    // Network error fetching robots.txt — allow all (fail-open for the fetch, but we still respect rules when found)
    log('warn', 'Failed to fetch robots.txt (allow all)', { origin, error: err.message });
  }

  robotsCache.set(origin, { rules, fetchedAt: Date.now() });
  return rules;
}

function parseRobotsTxt(text) {
  // Parse into groups: each group is a set of user-agent lines followed by rules
  const lines = text.split('\n');
  const groups = [];
  let currentGroup = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (key === 'user-agent') {
      // If previous line was also user-agent, add to same group
      // Otherwise start a new group
      if (!currentGroup || currentGroup.rules.length > 0) {
        currentGroup = { agents: [], rules: [] };
        groups.push(currentGroup);
      }
      currentGroup.agents.push(value.toLowerCase());
    } else if ((key === 'disallow' || key === 'allow') && currentGroup && value) {
      currentGroup.rules.push({ type: key, path: value });
    }
  }

  // Collect rules from groups that apply to us (* or couriobot)
  const rules = [];
  for (const group of groups) {
    const appliesToUs = group.agents.some(a => a === '*' || a === 'couriobot');
    if (appliesToUs) {
      rules.push(...group.rules);
    }
  }

  return rules;
}

function isPathAllowed(path, rules) {
  if (rules.length === 0) return true;

  // Find the most specific matching rule (longest path match wins, per RFC)
  let bestMatch = null;
  let bestLength = -1;

  for (const rule of rules) {
    // Check if rule path matches the beginning of the request path
    // Support wildcard * at end
    const rulePath = rule.path.replace(/\*$/, '');
    if (path.startsWith(rulePath) && rulePath.length > bestLength) {
      bestMatch = rule;
      bestLength = rulePath.length;
    }
  }

  if (!bestMatch) return true;
  return bestMatch.type === 'allow';
}

async function checkRobotsTxt(url) {
  if (!RESPECT_ROBOTS) return { allowed: true };

  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    const path = parsed.pathname;

    const rules = await fetchRobotsTxt(origin);
    const allowed = isPathAllowed(path, rules);

    if (!allowed) {
      log('info', 'Blocked by robots.txt', { url, origin, path });
    }

    return { allowed, origin, path };
  } catch (err) {
    log('warn', 'robots.txt check failed (allowing)', { url, error: err.message });
    return { allowed: true };
  }
}

// ── Scrape logic ────────────────────────────────────────────────────────

async function scrapePage(target) {
  const { url, selectors, waitFor, scrollFirst, clickFirst, jsEnabled, loadResources } = target;

  // Check robots.txt FIRST
  const robotsCheck = await checkRobotsTxt(url);
  if (!robotsCheck.allowed) {
    return {
      success: false,
      error: 'robots_txt_blocked',
      details: "This site's robots.txt disallows scraping this path",
      url,
    };
  }

  const startTime = Date.now();
  let retries = 0;

  const result = await withRetry(
    async (attempt) => {
      retries = attempt;
      const timeout = attempt === 0 ? 15000 : attempt === 1 ? 20000 : 30000;

      const { context, page } = await createContext({ jsEnabled, loadResources });

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
