# Courio Scraper

AI-powered internet intelligence microservice for Kay — Courio's AI concierge.
Combines Tavily AI search, Jina Reader, Google CSE, and Puppeteer into a single
research pipeline synthesized by Claude Sonnet. Kay gets live, verified answers
from the internet instead of guessing from training data.

## Stack

- Node.js + Express
- Claude Sonnet (claude-sonnet-4-6) — synthesis and extraction
- Tavily API — AI-native search with pre-extracted content + direct answers
- Jina Reader (r.jina.ai) — free, no-key URL → clean markdown
- Puppeteer + stealth plugin — JS-heavy site fallback
- Google CSE — supplemental search breadth
- In-memory TTL cache — no redundant scrapes

## Endpoints

### `GET /health` — No auth

### `POST /research` ← Primary endpoint for Kay
Full pipeline: Tavily + Google search → Jina/Puppeteer read top pages → Sonnet synthesis.
Returns a single synthesized answer string.

```json
{ "query": "Is Clay Oven on Pembina open right now?", "context": "Winnipeg delivery" }
```

### `POST /search`
Tavily + Google CSE in parallel. Returns ranked results + Tavily direct answer.

```json
{ "query": "pizza places open late Winnipeg", "maxResults": 5 }
```

### `POST /read`
Read any URL → clean markdown. Jina first, Puppeteer fallback.

```json
{ "url": "https://example.com/menu" }
```

### `POST /extract`
Read a URL and answer a specific question with Sonnet.

```json
{ "url": "https://restaurant.com", "question": "What are their hours on Sunday?" }
```

### `POST /price-check`
Items → structured price JSON from live web search.

```json
{ "items": ["4L milk", "dozen eggs", "sourdough bread"], "location": "Winnipeg" }
```

### `POST /scrape` / `POST /scrape-multi` — Legacy selector-based scraping

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SCRAPER_API_KEY` | Yes | Auth key (x-api-key header) |
| `ANTHROPIC_API_KEY` | Yes | Claude Sonnet for synthesis |
| `TAVILY_API_KEY` | Yes | AI-native search (tavily.com) |
| `GOOGLE_CSE_API_KEY` | No | Google Custom Search (supplemental) |
| `GOOGLE_CSE_ID` | No | Google CSE engine ID |
| `ALLOWED_ORIGINS` | No | CORS origins (default: localhost) |
| `PORT` | No | Server port (default: 3001) |

## Get a Tavily API Key

1. Sign up at https://tavily.com
2. Free tier: 1,000 searches/month
3. Add `TAVILY_API_KEY` to Railway env vars

## Deploy to Railway

1. Push to GitHub
2. Create Railway service from repo
3. Set env vars: `SCRAPER_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`
4. Railway auto-detects the Dockerfile

## Local Development

```bash
npm install
SCRAPER_API_KEY=test ANTHROPIC_API_KEY=sk-... TAVILY_API_KEY=tvly-... node src/server.js
```

## Cache TTLs

| Data type | TTL |
|-----------|-----|
| Search results | 15 min |
| Page reads | 10 min |
| Research answers | 10 min |
| Price checks | 5 min |
