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
 * ── Debug mode ────────────────────────────────────────────────────────────────
 * Add the header  X-Debug: true  to any POST request and the function returns
 * JSON instead of SSE with a full diagnostic snapshot:
 *
 *   {
 *     "debug": true,
 *     "keyPresent": true,
 *     "keyPrefix": "sk-or-v1-ab…",
 *     "model": "google/gemini-2.0-flash-001",
 *     "siteUrl": "https://flicoapp.in",
 *     "reachedOpenRouter": true,
 *     "openRouterStatus": 200,
 *     "openRouterOk": true,
 *     "openRouterErrorBody": null
 *   }
 *
 * Example:
 *   curl -s -X POST https://<your-pages-domain>/api/chat \
 *        -H "Content-Type: application/json" \
 *        -H "X-Debug: true" \
 *        -d '{"message":"ping"}' | jq
 */

const DEFAULT_MODEL  = 'google/gemini-2.5-flash';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Debug',
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

  // ── Is this a debug probe? ────────────────────────────────────────────────
  const isDebug = request.headers.get('X-Debug') === 'true';

  // ── Parse request body ────────────────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    if (isDebug) {
      return debugResponse({
        keyPresent: !!apiKey,
        keyPrefix:  apiKey ? apiKey.slice(0, 12) + '…' : 'MISSING',
        model,
        siteUrl,
        parseError: 'Invalid JSON body',
        reachedOpenRouter: false,
        openRouterStatus: null,
        openRouterOk: null,
        openRouterErrorBody: null,
      });
    }
    return jsonError(400, 'Invalid JSON body — could not parse as JSON.');
  }

  const { message, lang, mode, history, systemPrompt } = body ?? {};

  if (!message || typeof message !== 'string') {
    if (isDebug) {
      return debugResponse({
        keyPresent: !!apiKey,
        keyPrefix:  apiKey ? apiKey.slice(0, 12) + '…' : 'MISSING',
        model,
        siteUrl,
        parseError: 'Missing or invalid "message" field',
        reachedOpenRouter: false,
        openRouterStatus: null,
        openRouterOk: null,
        openRouterErrorBody: null,
      });
    }
    return jsonError(400, 'Missing or invalid "message" field in request body.');
  }

  // ── Diagnostic: log key presence + config on every request ───────────────
  console.log('[FLICO] /api/chat called', JSON.stringify({
    keyPresent: !!apiKey,
    keyPrefix:  apiKey ? apiKey.slice(0, 12) + '…' : 'MISSING',
    model,
    siteUrl,
    debug: isDebug,
  }));

  if (!apiKey) {
    console.error(
      '[FLICO] OPENROUTER_API_KEY is not set.',
      'Add it in Cloudflare Pages → Settings → Environment variables → Production + Preview.'
    );
    if (isDebug) {
      return debugResponse({
        keyPresent: false,
        keyPrefix:  'MISSING',
        model,
        siteUrl,
        reachedOpenRouter: false,
        openRouterStatus: null,
        openRouterOk: null,
        openRouterErrorBody: null,
      });
    }
    return jsonError(
      503,
      'Server misconfiguration: OPENROUTER_API_KEY is not set. ' +
      'Add it in Cloudflare Pages → Settings → Environment variables.'
    );
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

  // ── Call OpenRouter ────────────────────────────────────────────────────────
  // In debug mode: non-streaming so we can read the full response body.
  // In normal mode: streaming SSE.
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
        stream:      !isDebug,   // non-streaming in debug mode for easy body read
        max_tokens:  isDebug ? 16 : 1024,
        temperature: 0.7,
      }),
    });
  } catch (err) {
    console.error('[FLICO] fetch to OpenRouter threw (network error):', err.message);
    if (isDebug) {
      return debugResponse({
        keyPresent: true,
        keyPrefix:  apiKey.slice(0, 12) + '…',
        model,
        siteUrl,
        reachedOpenRouter: false,
        networkError: err.message,
        openRouterStatus: null,
        openRouterOk: null,
        openRouterErrorBody: null,
      });
    }
    return jsonError(502, `Could not reach OpenRouter: ${err.message}`);
  }

  // ── Debug mode: return diagnostic snapshot and stop ───────────────────────
  if (isDebug) {
    let openRouterErrorBody = null;
    let openRouterSuccessPreview = null;

    if (!upstream.ok) {
      try { openRouterErrorBody = await upstream.text(); } catch { openRouterErrorBody = '(unreadable)'; }
      console.error('[FLICO][debug] OpenRouter error', upstream.status, openRouterErrorBody);
    } else {
      // Read a small preview of the success body to confirm the model replied
      try {
        const txt = await upstream.text();
        openRouterSuccessPreview = txt.slice(0, 200);
      } catch { openRouterSuccessPreview = '(unreadable)'; }
    }

    return debugResponse({
      keyPresent: true,
      keyPrefix:  apiKey.slice(0, 12) + '…',
      model,
      siteUrl,
      reachedOpenRouter: true,
      openRouterStatus: upstream.status,
      openRouterOk: upstream.ok,
      openRouterErrorBody,
      openRouterSuccessPreview,
    });
  }

  // ── Forward OpenRouter errors verbatim (normal mode) ─────────────────────
  if (!upstream.ok) {
    let errorBody = '(could not read response body)';
    try { errorBody = await upstream.text(); } catch { /* ignore */ }

    console.error(
      '[FLICO] OpenRouter returned HTTP', upstream.status,
      '— full error body:', errorBody
    );

    return new Response(
      JSON.stringify({ error: `OpenRouter error ${upstream.status}`, detail: errorBody }),
      {
        status:  upstream.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      }
    );
  }

  // ── Re-stream as SSE in the format the frontend expects ───────────────────
  const { readable, writable } = new TransformStream();
  const writer  = writable.getWriter();
  const encoder = new TextEncoder();

  streamUpstreamToClient(upstream.body, writer, encoder);

  return new Response(readable, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type':      'text/event-stream; charset=utf-8',
      'Cache-Control':     'no-cache, no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function debugResponse(data) {
  return new Response(
    JSON.stringify({ debug: true, ...data }, null, 2),
    {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    }
  );
}

async function streamUpstreamToClient(upstreamBody, writer, encoder) {
  const reader  = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer          = '';
  let chunksForwarded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

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
          continue;
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
