/**
 * AI layer — Claude Sonnet for all extraction and synthesis.
 * Sonnet only. No Haiku. Kay deserves the best model.
 */

const { log } = require('./utils');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = 'claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 30000;

async function callSonnet(system, userMessage, options = {}) {
  if (!ANTHROPIC_KEY) {
    log('warn', 'Missing ANTHROPIC_API_KEY — Sonnet call skipped');
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT_MS);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: options.maxTokens || 1500,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('warn', 'Sonnet API non-OK', { status: res.status, body: body.slice(0, 200) });
      return null;
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text || null;
    log('info', 'Sonnet call done', {
      inputTokens: data?.usage?.input_tokens || 0,
      outputTokens: data?.usage?.output_tokens || 0,
    });
    return text;
  } catch (err) {
    log('warn', 'Sonnet call failed', { error: err.message });
    return null;
  }
}

/**
 * Extract structured JSON from page content using Sonnet.
 * schema is a plain JS object describing the shape — Sonnet fills it in.
 * Returns parsed object or null.
 */
async function extractFromContent(query, content, schema) {
  const system = `You are a precise information extraction specialist.
Extract exactly what is asked from the provided content.
Return ONLY valid JSON matching the requested schema. No markdown fences, no explanation, no extra text.
If a field is not found in the content, use null. Never hallucinate data.`;

  const userMessage = `Query: "${query}"

Content:
${content.slice(0, 10000)}

Return JSON matching this schema exactly:
${JSON.stringify(schema, null, 2)}`;

  const text = await callSonnet(system, userMessage, { maxTokens: 1500 });
  if (!text) return null;

  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    log('warn', 'JSON parse failed in extractFromContent', { error: err.message, preview: text.slice(0, 200) });
    return null;
  }
}

/**
 * Answer a specific question from page content.
 * Returns a plain text answer string or null.
 */
async function answerFromContent(url, question, content) {
  const system = `You extract specific answers from webpage content.
Answer the question based ONLY on the provided content. Be direct and specific.
If the answer is not in the content, respond with exactly: "Not found in this page."
Include exact details: prices, times, addresses, phone numbers as they appear.`;

  const userMessage = `URL: ${url}
Question: ${question}

Content:
${content.slice(0, 10000)}`;

  return await callSonnet(system, userMessage, { maxTokens: 600, timeout: 20000 });
}

/**
 * Synthesize a research answer from multiple page contents.
 * sources = [{ url, title, content }]
 * Returns a plain text answer string or null.
 */
async function synthesizeResearch(query, sources, context = '') {
  const system = `You are an expert research synthesizer for Courio, a same-day delivery service in Winnipeg, Manitoba.
You have gathered information from multiple live web sources to answer a customer query.

Synthesize a precise, factual answer using ONLY the provided sources.
Rules:
- Include exact names, addresses, prices, hours when found in sources
- If sources conflict, note the discrepancy and cite which source says what
- Never hallucinate facts not present in the sources
- If the answer is genuinely unknown from sources, say so clearly
- Be specific and direct — no filler, no hedging beyond what's warranted
- Format as clean prose or a brief list, whichever fits better`;

  const sourcesText = sources
    .slice(0, 5)
    .map((s, i) => `SOURCE ${i + 1} — ${s.title || s.url}:\n${(s.content || '').slice(0, 3000)}`)
    .join('\n\n---\n\n');

  const userMessage = `Query: "${query}"${context ? `\nContext: ${context}` : ''}

Sources:
${sourcesText}

Synthesize the best answer to the query from these sources.`;

  return await callSonnet(system, userMessage, { maxTokens: 1000, timeout: 30000 });
}

module.exports = { callSonnet, extractFromContent, answerFromContent, synthesizeResearch };
