import type { LlmClient } from "./types.js";

/** OpenAI-compatible chat client (FreeLLMAPI, Workers AI gateway, etc). Temperature 0; callers validate the output. */
export function openAiCompatible(baseUrl: string, apiKey: string, model: string, fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): LlmClient {
  return {
    async complete(prompt) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await fetchImpl(baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content: prompt }] }),
          signal: ctl.signal,
        });
        if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
        const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        return j.choices?.[0]?.message?.content ?? "";
      } finally {
        clearTimeout(t);
      }
    },
  };
}
