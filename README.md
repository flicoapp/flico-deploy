# FLICO — Cloudflare Pages Deployment

This folder is the complete, self-contained deployment package for the FLICO
website. Upload its contents to Cloudflare Pages and your site is live.

---

## Folder structure

```
flico-deploy/
├── index.html            ← FLICO frontend (unchanged from Replit version)
├── functions/
│   └── api/
│       └── chat.js       ← Cloudflare Pages Function — handles /api/chat
├── _headers              ← Security & CORS response headers
└── README.md             ← This file
```

Cloudflare Pages automatically discovers `functions/api/chat.js` and serves it
at `/api/chat` — the same relative URL the frontend already uses. **No changes
to `index.html` are needed.**

---

## Step-by-step deployment

### 1. Connect your repo to Cloudflare Pages

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com).
2. Go to **Workers & Pages → Create application → Pages → Connect to Git**.
3. Select your repository and the branch you want to deploy.
4. **Build settings:**
   - Framework preset: **None**
   - Build command: *(leave blank)*
   - Build output directory: `flico-deploy`
5. Click **Save and Deploy**.

> Alternatively, use [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/):
> ```bash
> npx wrangler pages deploy flico-deploy --project-name flico
> ```

---

### 2. Add the API key secret ← **critical step**

Your OpenRouter API key must be stored as a Cloudflare secret — it is never
exposed to the browser.

**In the Cloudflare Dashboard:**

1. Open your Pages project → **Settings → Environment variables**.
2. Click **Add variable**.
3. Set:
   - **Variable name:** `OPENROUTER_API_KEY`
   - **Value:** your OpenRouter key (starts with `sk-or-v1-…`)
   - **Encryption:** toggle **Secret** ON so the value is masked.
4. Add it to both **Production** and **Preview** environments.
5. Click **Save**.

**Optional variables (add the same way):**

| Variable    | Default                          | Purpose                                    |
|-------------|----------------------------------|--------------------------------------------|
| `AI_MODEL`  | `google/gemini-2.0-flash-001`    | Any OpenRouter model ID                    |
| `SITE_URL`  | `https://flico.pages.dev`        | Your live domain (used for HTTP-Referer)   |

---

### 3. Redeploy after adding the secret

Cloudflare does not automatically redeploy after you add environment variables.
Trigger a new deployment:

- **Dashboard:** Deployments tab → **Retry deployment** (on the latest deploy).
- **CLI:** run `npx wrangler pages deploy flico-deploy --project-name flico` again.

---

### 4. (Optional) Add a custom domain

Pages → **Custom domains → Set up a custom domain** → enter your domain and
follow the DNS instructions.

---

## How the API key stays secure

| Layer | What happens |
|-------|-------------|
| **Browser (`index.html`)** | Sends the chat message to `/api/chat` via `fetch()`. No API key anywhere in the HTML or JS. |
| **Cloudflare edge (`functions/api/chat.js`)** | Reads `OPENROUTER_API_KEY` from the Cloudflare secret store (server-side only), calls OpenRouter, and streams the reply back as SSE. |
| **OpenRouter** | Forwards the request to Gemini (or whichever model is configured). |

The API key never leaves Cloudflare's servers and is never visible in the
browser network tab, page source, or JS bundle.

---

## Streaming

The function streams token-by-token in Server-Sent Events format:

```
data: {"text":"Hello"}\n\n
data: {"text":", how"}\n\n
data: {"text":" can I help?"}\n\n
```

This is identical to what the Replit backend produced, so the frontend's
typewriter effect works without any changes.

---

## Testing locally with Wrangler

```bash
# From the repo root
npx wrangler pages dev flico-deploy --binding OPENROUTER_API_KEY=sk-or-v1-YOUR_KEY
```

Open http://localhost:8788 — the site and the chat function both run locally.

---

## Keeping Replit working

The Replit version continues to work as before. The `/api/chat` endpoint on
Replit is served by the Express API server in `artifacts/api-server/`. The
Cloudflare deployment is independent.
