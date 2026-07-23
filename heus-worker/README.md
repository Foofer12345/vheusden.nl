# HEUS HUB — Cloudflare Worker (the secure API proxy)

The page at **vheusden.nl/HEUSHUB** never talks to the LLM providers directly.
It talks to this Worker. The Worker holds your API keys as **secrets** (encrypted,
server-side) and forwards each request to the right provider. This is what makes
Qwen / ERNIE / Copilot work (they block direct browser calls) and keeps your keys
out of the public website.

It's on Cloudflare's **free plan** (100k requests/day — far more than one person needs).

---

## 1. One-time setup

You need [Node.js](https://nodejs.org) installed, then a free Cloudflare account.

```bash
cd heus-worker
npm install -g wrangler        # Cloudflare's CLI (or use: npx wrangler ...)
wrangler login                 # opens a browser to authorise
```

## 2. Add your secrets

Run each line and paste the value when prompted. **HEUS_PASSWORD is your login password**
for the hub — pick something only you know. Skip any provider you don't have a key for
(that provider just shows as "not configured" in the UI).

```bash
wrangler secret put HEUS_PASSWORD          # your personal login password
wrangler secret put ANTHROPIC_API_KEY      # Claude      -> console.anthropic.com
wrangler secret put OPENAI_API_KEY         # ChatGPT     -> platform.openai.com
wrangler secret put GEMINI_API_KEY         # Gemini      -> aistudio.google.com/apikey
wrangler secret put DEEPSEEK_API_KEY       # DeepSeek    -> platform.deepseek.com
wrangler secret put QWEN_API_KEY           # Qwen        -> DashScope (Alibaba Cloud)
wrangler secret put ERNIE_API_KEY          # ERNIE       -> Baidu Qianfan (v2 bearer token)
wrangler secret put COPILOT_API_KEY        # Copilot     -> GitHub PAT for GitHub Models
```

> **Copilot note:** Microsoft Copilot has no public API. This slot uses
> [GitHub Models](https://github.com/marketplace/models) (OpenAI-compatible,
> free tier), which is the closest drop-in. Create a GitHub Personal Access Token
> and paste it as `COPILOT_API_KEY`. You can repoint it to Azure OpenAI later by
> editing `base` for `copilot` in `worker.js`.

## 3. Deploy

```bash
wrangler deploy
```

Wrangler prints your Worker URL, e.g. `https://heus-hub.<your-subdomain>.workers.dev`.

## 4. Connect the hub

Open **vheusden.nl/HEUSHUB**, and on the first screen paste:

- **Worker URL** — the `https://heus-hub.….workers.dev` URL from step 3
- **Password** — the `HEUS_PASSWORD` you chose in step 2

That's it. Both are stored only in your browser. Do this once per device.

---

## Updating models or adding a provider

Model dropdowns come from `DEFAULT_MODELS` in `worker.js`, but the UI also lets you
type any model name. To change defaults, edit `worker.js` and run `wrangler deploy` again.

## Security model

- Keys live only as Cloudflare secrets — never in this repo, never in the browser.
- Every `/chat` and `/models` call requires `Authorization: Bearer <HEUS_PASSWORD>`.
- Because auth is required, even though the Worker URL is technically public, nobody
  can use your keys without the password.
- Want to lock it down further? You can restrict `Access-Control-Allow-Origin` to
  `https://vheusden.nl` in `corsHeaders()`.
