const BOT_USER_AGENT = 'CourioBot/1.0 (+https://couriodelivery.com)';

const VIEWPORT = { width: 1920, height: 1080 };

function randomDelay(min = 200, max = 800) {
  return new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));
}

function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

async function withRetry(fn, { maxRetries = 3, onRetry } = {}) {
  const backoffs = [1000, 3000, 7000];
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) break;

      const isBlocked = err.statusCode === 403 || err.statusCode === 429;
      const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout');
      const delay = isBlocked ? 10000 : backoffs[attempt] || 7000;

      log('warn', 'Retry attempt', {
        attempt: attempt + 1,
        reason: isBlocked ? 'blocked' : isTimeout ? 'timeout' : err.message,
        delayMs: delay,
      });

      if (onRetry) onRetry(attempt + 1, err);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

module.exports = {
  BOT_USER_AGENT,
  VIEWPORT,
  randomDelay,
  log,
  withRetry,
};
