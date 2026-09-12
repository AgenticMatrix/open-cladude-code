/**
 * model-connection-test.ts — "Test connection" probe for a provider's
 * baseUrl + apiKey. Mirrors agentstation-app's `model-connection-test.ts`, but
 * reduced to coderix-core's two wire protocols (anthropic messages vs. openai
 * chat completions).
 *
 * It does NOT send a real chat completion — it only checks that the endpoint
 * is reachable, authenticated, and can list its models (GET /v1/models, with
 * `/models` and trailing-slash fallbacks for gateways that put the endpoint
 * elsewhere). The discovered model ids are returned so the settings UI can
 * offer double-click-to-add. Returns a user-facing result rather than throwing.
 */

import { fetch as undiciFetch } from 'undici';

import { detectProtocol } from '../config.js';

export interface ConnectionTestInput {
  baseUrl: string;
  apiKey?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  /** Model ids discovered via the provider's models endpoint, if any. */
  models?: string[];
  /** Wire protocol of the baseUrl endpoint — probed by a real 1-token
   *  completion first, else inferred from the URL itself. */
  protocol?: 'anthropic' | 'openai';
}

const TIMEOUT_MS = 12_000;

type Auth = 'anthropic' | 'openai';
type Protocol = 'anthropic' | 'openai';

/** Minimal response shape — avoids depending on DOM lib types in this package. */
interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Best-effort extraction of the API's error message from a non-2xx body. */
function extractError(body: unknown): string {
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === 'object') {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === 'string' && msg) return msg;
    }
  }
  return '';
}

/** Pull model ids out of a `{ data: [{ id }] }` or `{ models: [{ id }] }`
 *  listing, tolerating `name` in place of `id` and plain-string entries. */
function extractModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const obj = body as Record<string, unknown>;
  const source = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.models)
      ? obj.models
      : null;
  if (!source) return [];
  const ids: string[] = [];
  for (const item of source) {
    if (typeof item === 'string' && item) {
      ids.push(item);
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const id = o.id ?? o.name;
      if (typeof id === 'string' && id) ids.push(id);
    }
  }
  return Array.from(new Set(ids));
}

function headersFor(auth: Auth, apiKey: string): Record<string, string> {
  return auth === 'anthropic'
    ? { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey }
    : { authorization: `Bearer ${apiKey}` };
}

/** Minimal 1-token completion body for each protocol, so detection is
 *  effectively free and needs only a real model id. */
function probeBody(protocol: Protocol, model: string): string {
  if (protocol === 'anthropic') {
    return JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  }
  return JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
}

/** The completion endpoint URL for a protocol. OpenAI endpoints drop the
 *  `/anthropic` alias (mirrors the adapters' `/chat/completions` path). */
function probeUrl(baseUrl: string, protocol: Protocol): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (protocol === 'anthropic') return `${base}/v1/messages`;
  const openaiBase = base.replace(/\/anthropic\/?$/i, '').replace(/\/+$/, '');
  return `${openaiBase}/chat/completions`;
}

/** Probe each protocol's completion endpoint (1-token request) and return the
 *  first that returns 2xx. Ordering follows the `detectProtocol` URL hint. */
async function detectProtocolByProbe(
  baseUrl: string,
  apiKey: string,
  model: string,
  signal: AbortSignal,
): Promise<Protocol | undefined> {
  const order: Protocol[] =
    detectProtocol(baseUrl) === 'anthropic'
      ? ['anthropic', 'openai']
      : ['openai', 'anthropic'];
  for (const protocol of order) {
    if (signal.aborted) return undefined;
    try {
      const res = (await undiciFetch(probeUrl(baseUrl, protocol), {
        method: 'POST',
        headers: { ...headersFor(protocol, apiKey), 'content-type': 'application/json' },
        body: probeBody(protocol, model),
        signal,
      })) as unknown as HttpResponse;
      if (res.ok) return protocol;
    } catch {
      if (signal.aborted) return undefined;
    }
  }
  return undefined;
}

/** Model-listing paths to try, most likely first. For an Anthropic `/anthropic`
 *  path we additionally probe the same host's OpenAI root — several providers
 *  (deepseek, minimax, moonshot, …) expose both protocols on one host but only
 *  serve `/v1/models` on the OpenAI root. */
function buildModelListCandidates(baseUrl: string): { url: string; auth: Auth }[] {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (detectProtocol(baseUrl) === 'anthropic') {
    const candidates: { url: string; auth: Auth }[] = [
      { url: `${base}/v1/models`, auth: 'anthropic' },
      { url: `${base}/v1/models/`, auth: 'anthropic' },
      { url: `${base}/models`, auth: 'anthropic' },
      { url: `${base}/models/`, auth: 'anthropic' },
    ];
    if (base.toLowerCase().includes('/anthropic')) {
      try {
        const origin = new URL(base).origin;
        candidates.push(
          { url: `${origin}/v1/models`, auth: 'openai' },
          { url: `${origin}/models`, auth: 'openai' },
        );
      } catch {
        // base isn't a parseable URL — skip the root probe.
      }
    }
    return candidates;
  }
  return [
    { url: `${base}/models`, auth: 'openai' },
    { url: `${base}/models/`, auth: 'openai' },
    { url: `${base}/v1/models`, auth: 'openai' },
    { url: `${base}/v1/models/`, auth: 'openai' },
  ];
}

export async function testModelConnection(input: ConnectionTestInput): Promise<ConnectionTestResult> {
  const apiKey = (input.apiKey || '').trim();
  const base = input.baseUrl.trim().replace(/\/+$/, '');
  if (!base) return { ok: false, message: 'Base URL 为空' };

  const candidates = buildModelListCandidates(input.baseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  // Best error to report if no candidate gives a definitive answer.
  let lastError: ConnectionTestResult | null = null;
  // A 401/403 may be specific to one path/header scheme (e.g. an Anthropic key
  // hitting the OpenAI root with Bearer), so keep probing and only surface it
  // if no other candidate explains the failure.
  let authError: ConnectionTestResult | null = null;
  let reached2xx = false;

  try {
    for (const { url, auth } of candidates) {
      let res: HttpResponse;
      try {
        res = (await undiciFetch(url, {
          method: 'GET',
          headers: headersFor(auth, apiKey),
          signal: controller.signal,
        })) as unknown as HttpResponse;
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          return { ok: false, message: `连接超时（>${TIMEOUT_MS / 1000}s）` };
        }
        const msg = err instanceof Error ? err.message : String(err);
        lastError = lastError ?? { ok: false, message: `无法连接：${msg}` };
        continue;
      }

      const latencyMs = Date.now() - started;

      if (res.ok) {
        reached2xx = true;
        const text = await res.text();
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
        const models = extractModelIds(body);
        if (models.length) {
          const probed = await detectProtocolByProbe(input.baseUrl, apiKey, models[0], controller.signal);
          const protocol = probed ?? detectProtocol(input.baseUrl);
          return { ok: true, message: `连接成功 (${latencyMs}ms)`, latencyMs, models, protocol };
        }
        // Reachable + authenticated, but this path didn't return a model list
        // (e.g. an HTML dashboard) — try the next candidate.
        continue;
      }

      const text = await res.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
      const detail = extractError(body);
      const suffix = detail ? `：${detail}` : '';

      if (res.status === 401 || res.status === 403) {
        authError = authError ?? {
          ok: false,
          message: `认证失败 (HTTP ${res.status})：请检查 API Key`,
          latencyMs,
        };
        continue;
      }
      if (res.status === 404) {
        lastError = lastError ?? {
          ok: false,
          message: `接口不存在 (HTTP 404)：请检查 Base URL 或协议`,
          latencyMs,
        };
        continue;
      }
      if (res.status >= 500) {
        lastError = lastError ?? { ok: false, message: `服务端错误 (HTTP ${res.status})${suffix}`, latencyMs };
        continue;
      }
      lastError = lastError ?? { ok: false, message: `请求被拒绝 (HTTP ${res.status})${suffix}`, latencyMs };
    }

    // We reached the API and auth passed somewhere, but no path returned a
    // model list — report that rather than a fallback path's auth error.
    if (reached2xx) {
      return { ok: false, message: '接口可用，但未返回模型列表', protocol: detectProtocol(input.baseUrl) };
    }
    return authError ?? lastError ?? { ok: false, message: '无法获取模型列表' };
  } finally {
    clearTimeout(timer);
  }
}
