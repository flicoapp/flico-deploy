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
 *   AI_MODEL   — OpenRouter model ID (default: google/gemini-2.0-flash-001)
 *   SITE_URL   — your live domain for the HTTP-Referer header (default: https://flicoapp.in)
 *
 * Logs (visible in Cloudflare Pages → Deployments → Real-time logs):
 *   [FLICO] key present, model, message count on every request
 *   [FLICO] OpenRouter HTTP status + full error body on failures
 *   [FLICO] chunks forwarded count on successful streams
 */

const DEFAULT_MODEL  = 'google/gemini-2.0-flash-001';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── CORS preflight ────────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  const apiKey  = env.OPENROUTER_API_KEY;
  const model   = env.AI_MODEL   || DEFAULT_MODEL;
  const siteUrl = env.SITE_URL   || 'https://flicoapp.in';

  // ── Diagnostic: log key presence + config on every request ───────────────
  // (key value is never logged — only whether it is present)
  console.log('[FLICO] /api/chat called', JSON.stringify({
    keyPresent: !!apiKey,
    keyPrefix:  apiKey ? apiKey.slice(0, 12) + '…' : 'MISSING',
    model,
    siteUrl,
  }));

  if (!apiKey) {
    console.error(
      '[FLICO] OPENROUTER_API_KEY is not set.',
      'Add it in Cloudflare Pages → Settings → Environment variables → Production + Preview.'
    );
    return jsonError(
      503,
      'Server misconfiguration: OPENROUTER_API_KEY is not set. ' +
      'Add it in Cloudflare Pages → Settings → Environment variables.'
    );
  }

  // ── Parse request body ────────────────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Invalid JSON body — could not parse as JSON.');
  }

  const { message, lang, mode, history, systemPrompt } = body ?? {};

  if (!message || typeof message !== 'string') {
    return jsonError(400, 'Missing or invalid "message" field in request body.');
  }

  // ── Build messages array (OpenAI / OpenRouter format) ─────────────────────
  /** @type {Array<{role: string, content: string}>} */
  const messages = [];

  if (systemPrompt && typeof systemPrompt === 'string') {
    messages.push({ role: 'system', content: systemPrompt });
  }

  if (Array.isArray(history)) {
    for (const turn of history) {
      if (!turn?.text) continue;
      const role = turn.role === 'model' ? 'assistant' : 'user';
      messages.push({ role, content: turn.text });
    }
  }

  messages.push({ role: 'user', content: message });

  console.log('[FLICO] Calling OpenRouter —', JSON.stringify({ model, messageCount: messages.length }));

  // ── Call OpenRouter with streaming ────────────────────────────────────────
  let upstream;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'HTTP-Referer':  siteUrl,
        'X-Title':       'FLICO AI Assistant',
      },
      body: JSON.stringify({
        model,
        messages,
        stream:      true,
        max_tokens:  1024,
        temperature: 0.7,
      }),
    });
  } catch (err) {
    console.error('[FLICO] fetch to OpenRouter threw (network error):', err.message);
    return jsonError(502, `Could not reach OpenRouter: ${err.message}`);
  }

  // ── Forward OpenRouter errors verbatim ───────────────────────────────────
  if (!upstream.ok) {
    let errorBody = '(could not read response body)';
    try { errorBody = await upstream.text(); } catch { /* ignore */ }

    console.error(
      '[FLICO] OpenRouter returned HTTP', upstream.status,
      '— full error body:', errorBody
    );

    // Return the real status code + full error body so the browser console
    // and any monitoring can see exactly what OpenRouter said.
    return new Response(
      JSON.stringify({ error: `OpenRouter error ${upstream.status}`, detail: errorBody }),
      {
        status:  upstream.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      }
    );
  }

  // ── Re-stream as SSE in the format the frontend expects ───────────────────
  // Frontend expects lines: data: {"text":"<token>"}\n\n
  const { readable, writable } = new TransformStream();
  const writer  = writable.getWriter();
  const encoder = new TextEncoder();

  // Run in background — return the readable stream immediately.
  streamUpstreamToClient(upstream.body, writer, encoder);

  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type':    'text/event-stream; charset=utf-8',
      'Cache-Control':   'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function streamUpstreamToClient(upstreamBody, writer, encoder) {
  const reader  = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer         = '';
  let chunksForwarded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline (SSE event boundary)
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const evt of events) {
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
          chunksForwarded++;
          await writer.write(encoder.encode(`data: ${JSON.stringify({ text: delta })}\n\n`));
        }
      }
    }

    console.log('[FLICO] Stream finished — chunks forwarded to client:', chunksForwarded);
    if (chunksForwarded === 0) {
      console.warn('[FLICO] Stream finished but zero text chunks were forwarded. Check model response format.');
    }
  } catch (err) {
    console.error('[FLICO] Error while streaming to client:', err.message);
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
