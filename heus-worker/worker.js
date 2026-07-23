/**
 * HEUS HUB — Cloudflare Worker proxy
 * ----------------------------------
 * One secure endpoint that fans out to every LLM provider. API keys live here
 * as Worker secrets (never in the browser, never in the public site repo).
 *
 * Endpoints (all require  Authorization: Bearer <HEUS_PASSWORD> ):
 *   GET  /health   -> { ok: true }                     (no auth, for connectivity checks)
 *   GET  /models   -> { providers: {...} }             (which providers have a key + default models)
 *   POST /chat     -> { provider, model, messages, system?, temperature?, max_tokens? }
 *                     returns { text, provider, model, usage?, raw? }
 *
 * Deploy: see README.md in this folder.
 */

const DEFAULT_MODELS = {
  claude:   ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  openai:   ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1"],
  gemini:   ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-pro"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  qwen:     ["qwen-max", "qwen-plus", "qwen-turbo"],
  ernie:    ["ernie-4.5-turbo-128k", "ernie-4.0-8k", "ernie-3.5-8k"],
  copilot:  ["gpt-4o", "gpt-4o-mini", "o1-preview"],
};

const LABELS = {
  claude:   "Claude (Anthropic)",
  openai:   "ChatGPT (OpenAI)",
  gemini:   "Gemini (Google)",
  deepseek: "DeepSeek",
  qwen:     "Qwen (Alibaba)",
  ernie:    "ERNIE (Baidu)",
  copilot:  "Copilot (GitHub Models)",
};

function providerConfig(env) {
  return {
    claude:   { kind: "anthropic", key: env.ANTHROPIC_API_KEY, base: "https://api.anthropic.com/v1/messages" },
    openai:   { kind: "openai",    key: env.OPENAI_API_KEY,    base: "https://api.openai.com/v1/chat/completions" },
    gemini:   { kind: "gemini",    key: env.GEMINI_API_KEY,    base: "https://generativelanguage.googleapis.com/v1beta/models" },
    deepseek: { kind: "openai",    key: env.DEEPSEEK_API_KEY,  base: "https://api.deepseek.com/chat/completions" },
    qwen:     { kind: "openai",    key: env.QWEN_API_KEY,      base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions" },
    ernie:    { kind: "openai",    key: env.ERNIE_API_KEY,     base: "https://qianfan.baidubce.com/v2/chat/completions" },
    copilot:  { kind: "openai",    key: env.COPILOT_API_KEY,   base: "https://models.inference.ai.azure.com/chat/completions" },
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // Health check is open so the page can test connectivity before login.
    if (url.pathname === "/health") return json({ ok: true }, cors);

    // Everything else needs the shared password.
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!env.HEUS_PASSWORD) return json({ error: "Worker not configured: HEUS_PASSWORD secret is missing." }, cors, 500);
    if (token !== env.HEUS_PASSWORD) return json({ error: "Unauthorized — wrong password." }, cors, 401);

    const cfg = providerConfig(env);

    if (url.pathname === "/models" && request.method === "GET") {
      const providers = {};
      for (const id of Object.keys(cfg)) {
        providers[id] = {
          label: LABELS[id],
          configured: Boolean(cfg[id].key),
          models: DEFAULT_MODELS[id] || [],
        };
      }
      return json({ providers }, cors);
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Invalid JSON body." }, cors, 400); }

      const { provider, model } = body;
      const p = cfg[provider];
      if (!p) return json({ error: `Unknown provider: ${provider}` }, cors, 400);
      if (!p.key) return json({ error: `No API key configured for ${LABELS[provider] || provider}. Add its secret in Cloudflare.` }, cors, 400);
      if (!model) return json({ error: "No model selected." }, cors, 400);

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = body.system || "";
      const temperature = typeof body.temperature === "number" ? body.temperature : undefined;
      const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 2048;

      try {
        let result;
        if (p.kind === "anthropic")   result = await callAnthropic(p, model, messages, system, temperature, maxTokens);
        else if (p.kind === "gemini") result = await callGemini(p, model, messages, system, temperature, maxTokens);
        else                          result = await callOpenAICompatible(p, model, messages, system, temperature, maxTokens);
        return json({ provider, model, ...result }, cors);
      } catch (err) {
        return json({ error: String(err && err.message || err) }, cors, 502);
      }
    }

    return json({ error: "Not found." }, cors, 404);
  },
};

/* ------------------------------ providers ------------------------------ */

async function callOpenAICompatible(p, model, messages, system, temperature, maxTokens) {
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  for (const m of messages) msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });

  const payload = { model, messages: msgs, max_tokens: maxTokens };
  if (temperature !== undefined) payload.temperature = temperature;

  const res = await fetch(p.base, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${p.key}` },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(extractErr(data) || `HTTP ${res.status}`);
  const text = data?.choices?.[0]?.message?.content ?? "";
  return { text, usage: data.usage, raw: undefined };
}

async function callAnthropic(p, model, messages, system, temperature, maxTokens) {
  const payload = {
    model,
    max_tokens: maxTokens,
    messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
  };
  if (system) payload.system = system;
  if (temperature !== undefined) payload.temperature = temperature;

  const res = await fetch(p.base, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": p.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(extractErr(data) || `HTTP ${res.status}`);
  const text = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, usage: data.usage };
}

async function callGemini(p, model, messages, system, temperature, maxTokens) {
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const payload = { contents, generationConfig: { maxOutputTokens: maxTokens } };
  if (temperature !== undefined) payload.generationConfig.temperature = temperature;
  if (system) payload.systemInstruction = { parts: [{ text: system }] };

  const endpoint = `${p.base}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(p.key)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(extractErr(data) || `HTTP ${res.status}`);
  const text = (data?.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
  return { text, usage: data.usageMetadata };
}

/* ------------------------------ helpers ------------------------------ */

function extractErr(data) {
  if (!data) return "";
  if (typeof data.error === "string") return data.error;
  if (data.error && data.error.message) return data.error.message;
  if (data.message) return data.message;
  return "";
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
