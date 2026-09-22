// Microsoft Foundry (Azure OpenAI) client. Entra ID only: there is no API key anywhere. In Azure,
// DefaultAzureCredential resolves to the Function App's managed identity, which needs the role
// "Cognitive Services OpenAI User" on the Foundry resource. Locally it uses your `az login` session.
//
// The client does one thing: send a prompt, get back JSON that conforms to a schema. It never logs prompts or replies,
// and its error messages never include transcript text.

export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "AiError";
    this.status = status;
  }
}

// Documentation has used both scopes for the v1 API. Try the classic one first, then the newer one on a 401.
const DEFAULT_SCOPES = ["https://cognitiveservices.azure.com/.default", "https://ai.azure.com/.default"];

/** https://name.openai.azure.com, .cognitiveservices.azure.com and .services.ai.azure.com (with or without a project path) all reduce to the origin. */
export function baseUrl(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    throw new Error("FOUNDRY_ENDPOINT is not a valid URL.");
  }
  if (u.protocol !== "https:") throw new Error("FOUNDRY_ENDPOINT must be https.");
  return `${u.origin}/openai/v1/chat/completions`;
}

/**
 * credential: anything with getToken(scope) -> { token }. Injected so tests never touch Azure.
 * fetchImpl: injected for tests.
 */
export function createFoundryClient({ endpoint, deployment, credential, scopes = DEFAULT_SCOPES, fetchImpl = fetch, timeoutMs = 120_000, reasoningEffort = "", log = () => {} }) {
  if (!endpoint || !deployment) throw new Error("Foundry needs FOUNDRY_ENDPOINT and FOUNDRY_DEPLOYMENT.");
  const url = baseUrl(endpoint);
  let scopeIdx = 0;

  async function post(body, scope) {
    const tok = await credential.getToken(scope);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok.token}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      if (e?.name === "AbortError") throw new AiError("The AI service took too long to answer. Try a shorter transcript, or try again.", 504);
      throw new AiError("Could not reach the AI service.", 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async function errorText(res) {
    try {
      const j = await res.json();
      return `${j?.error?.code ?? ""} ${j?.error?.message ?? ""}`.trim().slice(0, 300);
    } catch {
      return "";
    }
  }

  return {
    kind: "foundry",
    deployment,

    /** Returns the parsed JSON object the model produced. */
    // maxTokens is generous on purpose: on reasoning models (gpt-5 family, o-series) the hidden reasoning tokens
    // count against max_completion_tokens, so a small cap can be spent thinking and leave an empty answer.
    async extract({ system, user, schema, name = "result", maxTokens = 16000 }) {
      const body = {
        model: deployment,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
        max_completion_tokens: maxTokens,
      };
      // Optional. Only reasoning models accept it, so it is sent only when FOUNDRY_REASONING_EFFORT is set.
      if (reasoningEffort) body.reasoning_effort = reasoningEffort;

      let res;
      let retried429 = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        res = await post(body, scopes[scopeIdx]);
        if (res.ok) break;
        const msg = await errorText(res);
        if (res.status === 401 && scopeIdx < scopes.length - 1) { scopeIdx++; continue; } // wrong token audience
        if (res.status === 400 && "max_completion_tokens" in body && /max_completion_tokens/i.test(msg)) {
          body.max_tokens = body.max_completion_tokens; // older model deployments only know max_tokens
          delete body.max_completion_tokens;
          continue;
        }
        if (res.status === 400 && "reasoning_effort" in body && /reasoning_effort|reasoning effort/i.test(msg)) {
          delete body.reasoning_effort; // this deployment is not a reasoning model, or does not accept that level
          continue;
        }
        if ((res.status === 429 || res.status === 503) && !retried429) {
          retried429 = true;
          const wait = Math.min(Number(res.headers?.get?.("retry-after")) || 2, 8);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        log(`Foundry error ${res.status}: ${msg}`);
        if (res.status === 401 || res.status === 403) {
          throw new AiError("The app is not allowed to use the Foundry resource. Its managed identity needs the Cognitive Services OpenAI User role, and role changes can take a few minutes.", 502);
        }
        if (res.status === 404) throw new AiError("The Foundry deployment was not found. Check FOUNDRY_ENDPOINT and FOUNDRY_DEPLOYMENT.", 502);
        if (res.status === 429) throw new AiError("The AI service is busy or out of quota. Try again in a minute.", 503);
        if (res.status === 400 && /content[_ ]filter|content management policy|responsibleai/i.test(msg)) {
          throw new AiError("The AI service's content filter blocked this transcript. Nothing was saved.", 422);
        }
        throw new AiError(`The AI service returned an error (${res.status}).`, 502);
      }
      if (!res?.ok) throw new AiError("The AI service returned an error.", 502);

      let data;
      try {
        data = await res.json();
      } catch {
        throw new AiError("The AI service returned something unreadable.", 502);
      }
      const choice = data?.choices?.[0];
      if (choice?.message?.refusal) throw new AiError("The AI service declined to analyse this transcript.", 422);
      if (choice?.finish_reason === "length") throw new AiError("The AI answer was cut off. Try a shorter transcript.", 502);
      if (choice?.finish_reason === "content_filter") throw new AiError("The AI service's content filter blocked this transcript. Nothing was saved.", 422);
      try {
        return JSON.parse(choice?.message?.content ?? "");
      } catch {
        throw new AiError("The AI answer was not valid JSON. Try again.", 502);
      }
    },
  };
}

/**
 * Build the client from environment settings, or return null when Foundry is not configured
 * (the feature then reports "not configured" instead of failing).
 */
export async function aiFromEnv(env = process.env, log = () => {}) {
  if (!env.FOUNDRY_ENDPOINT || !env.FOUNDRY_DEPLOYMENT) return null;
  const { DefaultAzureCredential } = await import("@azure/identity");
  return createFoundryClient({
    endpoint: env.FOUNDRY_ENDPOINT,
    deployment: env.FOUNDRY_DEPLOYMENT,
    credential: new DefaultAzureCredential(),
    reasoningEffort: String(env.FOUNDRY_REASONING_EFFORT ?? "").trim().toLowerCase(),
    log,
  });
}
