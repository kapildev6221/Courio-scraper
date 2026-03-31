const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { log } = require('./utils');

const BLOCKED_PATH_KEYWORDS = ['/login', '/checkout', '/payment', '/account', '/auth', '/signin', '/signup'];

function authMiddleware(req, res, next) {
  if (req.path === '/health') return next();

  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) {
    log('warn', 'SCRAPER_API_KEY not set — all requests allowed');
    return next();
  }

  const provided = req.headers['x-api-key'];
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ success: false, error: 'Unauthorized — invalid or missing x-api-key' });
  }
  next();
}

function validateScrapeBody(req, res, next) {
  const { url, selectors } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'url is required and must be a string' });
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return res.status(400).json({ success: false, error: 'url must start with http:// or https://' });
  }

  const lower = url.toLowerCase();
  for (const keyword of BLOCKED_PATH_KEYWORDS) {
    if (lower.includes(keyword)) {
      return res.status(403).json({ success: false, error: `Blocked: URL contains restricted path "${keyword}"` });
    }
  }

  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) {
    return res.status(400).json({ success: false, error: 'selectors is required and must be an object { key: "css selector" }' });
  }

  next();
}

function validateMultiBody(req, res, next) {
  const { targets } = req.body;

  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ success: false, error: 'targets is required and must be a non-empty array' });
  }

  if (targets.length > 10) {
    return res.status(400).json({ success: false, error: 'Maximum 10 targets per request' });
  }

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t.url || typeof t.url !== 'string' || (!t.url.startsWith('http://') && !t.url.startsWith('https://'))) {
      return res.status(400).json({ success: false, error: `Target ${i}: url must be a valid http(s) URL` });
    }

    const lower = t.url.toLowerCase();
    for (const keyword of BLOCKED_PATH_KEYWORDS) {
      if (lower.includes(keyword)) {
        return res.status(403).json({ success: false, error: `Target ${i}: URL contains restricted path "${keyword}"` });
      }
    }

    if (!t.selectors || typeof t.selectors !== 'object' || Array.isArray(t.selectors)) {
      return res.status(400).json({ success: false, error: `Target ${i}: selectors must be an object` });
    }
  }

  next();
}

function requestLogger(req, res, next) {
  log('info', 'Request', { method: req.method, path: req.path });
  next();
}

function setupMiddleware(app) {
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } } }));

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map(o => o.trim());

  app.use(cors({ origin: allowedOrigins }));

  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Rate limit exceeded — max 30 requests/min' },
  }));

  app.use(require('express').json({ limit: '1mb' }));
  app.use(requestLogger);
  app.use(authMiddleware);
}

module.exports = { setupMiddleware, validateScrapeBody, validateMultiBody };
