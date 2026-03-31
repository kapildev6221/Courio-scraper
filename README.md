# Courio Scraper

Production-grade stealth scraper microservice for live price extraction. Runs as a separate Railway service that the Courio app calls to scrape product prices, menu items, and store data from any website.

## Stack

- Node.js + Express
- Puppeteer with bundled Chromium
- puppeteer-extra + stealth plugin (anti-detection)
- Docker (Railway-ready)

## Anti-Detection

- Stealth plugin bypasses bot detection (WebDriver, Chrome.runtime, plugins, etc.)
- Randomized user-agents from 12 real Chrome/Firefox/Safari/Edge strings
- Randomized viewport sizes (7 common resolutions)
- Random human-like delays between actions
- Realistic HTTP headers (Accept-Language, Sec-Fetch, Referer)
- Fresh incognito context per request (clean cookies/state)
- Image/font/media blocking for speed
- Browser auto-restart every 50 requests

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Server port |
| `SCRAPER_API_KEY` | Yes | — | API key for authentication (x-api-key header) |
| `ALLOWED_ORIGINS` | No | `localhost` | Comma-separated CORS origins |

## Endpoints

### `GET /health`

No auth required.

```bash
curl http://localhost:3001/health
```

```json
{
  "status": "ok",
  "uptime": 3600,
  "activeTabs": 0,
  "totalScrapes": 42,
  "successRate": 97.6,
  "browserConnected": true
}
```

### `POST /scrape`

Scrape a single URL.

```bash
curl -X POST http://localhost:3001/scrape \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "url": "https://example.com/product/123",
    "selectors": {
      "name": "h1.product-title",
      "price": ".price-current",
      "description": "meta[name=description]"
    },
    "waitFor": ".price-current",
    "scrollFirst": false,
    "clickFirst": "#accept-cookies",
    "jsEnabled": true,
    "loadResources": false
  }'
```

```json
{
  "success": true,
  "data": {
    "name": "Product Name",
    "price": "$12.99",
    "description": "Product description here"
  },
  "scrapedAt": "2026-03-30T01:00:00.000Z",
  "responseTimeMs": 2340,
  "retries": 0
}
```

### `POST /scrape-multi`

Scrape multiple URLs (up to 10, 3 at a time in parallel).

```bash
curl -X POST http://localhost:3001/scrape-multi \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "targets": [
      {
        "url": "https://store.com/item/1",
        "selectors": { "price": ".price" }
      },
      {
        "url": "https://store.com/item/2",
        "selectors": { "price": ".price" }
      }
    ]
  }'
```

```json
{
  "results": [
    { "url": "https://store.com/item/1", "success": true, "data": { "price": "$5.99" }, "responseTimeMs": 1200 },
    { "url": "https://store.com/item/2", "success": true, "data": { "price": "$3.49" }, "responseTimeMs": 1350 }
  ],
  "totalTimeMs": 1400
}
```

## Request Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | required | URL to scrape |
| `selectors` | object | required | `{ key: "css selector" }` mapping |
| `waitFor` | string | — | CSS selector to wait for before extracting |
| `scrollFirst` | boolean | false | Scroll to bottom first (lazy-loaded content) |
| `clickFirst` | string | — | CSS selector to click first (cookie banners, "show more") |
| `jsEnabled` | boolean | true | Enable JavaScript on the page |
| `loadResources` | boolean | false | Load images, fonts, stylesheets |

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway service from the repo
3. Set environment variables: `SCRAPER_API_KEY`, `ALLOWED_ORIGINS`
4. Railway auto-detects the Dockerfile and deploys

## Local Development

```bash
npm install
SCRAPER_API_KEY=test-key node src/server.js
```
