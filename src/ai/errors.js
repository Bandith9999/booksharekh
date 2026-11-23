import { clamp } from '../helpers.js';

// Error kinds shared by every provider. Retry and fallback decisions use these, never raw messages.
//   auth, quota, model_not_found, bad_request, config, budget, refusal, truncated  -> not retryable
//   rate_limit, overloaded, server, timeout, network, invalid_output               -> retryable
const RETRYABLE = new Set(['rate_limit', 'overloaded', 'server', 'timeout', 'network', 'invalid_output']);
// Only these may trigger an (explicitly enabled) fallback provider. Refusals never do.
export const AVAILABILITY_KINDS = new Set(['rate_limit', 'overloaded', 'server', 'timeout', 'network']);

export class AIError extends Error {
  constructor(message, { kind = 'unknown', status = null, provider = null, retryAfter = null, usage = null } = {}) {
    super(message);
    this.name = 'AIError';
    this.kind = kind;
    this.status = status;
    this.provider = provider;
    this.retryAfter = retryAfter; // seconds, from the provider's Retry-After header
    this.usage = usage;           // tokens already spent, when the provider reported them
  }
  get retryable() { return RETRYABLE.has(this.kind); }
}

export function kindForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limit';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

export function retryAfterSeconds(response) {
  const n = Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 3600) : null;
}

// Provider error bodies describe the request problem; they never echo our auth headers.
export function errorDetail(body) {
  const e = body?.error;
  if (!e) return '';
  return typeof e === 'string' ? e : [e.type || e.status || e.code, e.message].filter(Boolean).join(': ');
}

// fetch with a hard timeout; network failures become typed AIErrors.
export async function fetchJson(provider, url, init, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new AIError(`${provider} request timed out after ${timeoutMs / 1000}s`, { kind: 'timeout', provider });
    }
    throw new AIError(`${provider} network error: ${clamp(e?.message, 120)}`, { kind: 'network', provider });
  }
  const body = await response.json().catch(() => null);
  return { response, body };
}
