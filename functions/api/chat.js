/**
 * Cloudflare Pages Function — POST /api/chat
 *
 * Receives the AI chat request from the FLICO frontend, forwards it to
 * OpenRouter (which routes to Gemini), and streams the reply back as
 * Server-Sent Events in the format the frontend expects:
 *
 *   data: {"text":"<token>"}\n\n
 *
 * Required Cloudflare secret (set in Pages → Settings → Environment variables):
 *   OPENROUTER_API_KEY  — your OpenRouter API key (sk-or-v1-...)
 *
 * Optional:
 *   AI_MODEL            — OpenRouter model ID (default: google/gemini-2.0-flash-001)
 *   SITE_URL            — your Cloudflare Pages URL for the HTTP-Referer header
 */

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── CORS preflight ───────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return jsonError(500, 'OPENROUTER_API_KEY is not configured on this deployment.');
  }

  // ── Parse request body ────────────────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Invalid JSON body.');
  }

  const { message, lang, mode, history, systemPrompt } = body ?? {};

  if (!message || typeof message !== 'string') {
    return jsonError(400, 'Missing or invalid "message" field.');
  }

  // ── Build messages array (OpenAI / OpenRouter format) ─────────────────────
  /** @type {Array<{role: string, content: string}>} */
  const messages = [];

  // System prompt is built on the client from FLICO's KB and sent here so the
  // Worker never needs to hardcode brand facts — they live in the HTML.
  if (systemPrompt && typeof systemPrompt === 'string') {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // Recent conversation history (Gemini uses "model"; OpenRouter uses "assistant")
  if (Array.isArray(history)) {
    for (const turn of history) {
      if (!turn?.text) continue;
      const role = turn.role === 'model' ? 'assistant' : 'user';
      messages.push({ role, content: turn.text });
    }
  }

  messages.push({ role: 'user', content: message });

  // ── Call OpenRouter with streaming ────────────────────────────────────────
  const model = env.AI_MODEL || DEFAULT_MODEL;
  const siteUrl = env.SITE_URL || 'https://flico.pages.dev';

  let upstream;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': siteUrl,
        'X-Title': 'FLICO AI Assistant',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });
  } catch (err) {
    return jsonError(502, `Could not reach OpenRouter: ${err.message}`);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return jsonError(upstream.status, `OpenRouter returned ${upstream.status}: ${detail}`);
  }

  // ── Re-stream as SSE in the format the frontend parser expects ────────────
  // Frontend parser (in index.html) expects lines like:
  //   data: {"text":"<token>"}\n\n
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Run in background — do not await; return the readable immediately.
  streamUpstreamToClient(upstream.body, writer, encoder);

  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no', // disable nginx buffering on some proxies
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function streamUpstreamToClient(upstreamBody, writer, encoder) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline (SSE event boundary)
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? ''; // keep incomplete trailing fragment

      for (const evt of events) {
        // Find the data line inside this SSE event
        const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;

        const payload = dataLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // skip malformed chunks
        }

        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          const sseChunk = `data: ${JSON.stringify({ text: delta })}\n\n`;
          await writer.write(encoder.encode(sseChunk));
        }
      }
    }
  } catch {
    // Stream ended or was aborted — close cleanly
  } finally {
    try { await writer.close(); } catch { /* already closed */ }
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
