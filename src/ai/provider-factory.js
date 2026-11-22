import { AIError } from './errors.js';
import { anthropicProvider } from './anthropic-provider.js';
import { openaiProvider } from './openai-provider.js';
import { geminiProvider } from './gemini-provider.js';
import { mockProvider } from './mock-provider.js';

const PROVIDERS = { anthropic: anthropicProvider, openai: openaiProvider, google: geminiProvider, mock: mockProvider };
export const PROVIDER_NAMES = Object.keys(PROVIDERS);

// 'gemini' is accepted as an alias of 'google' (the Phase 1 AI_PROVIDER value).
export function normalizeProvider(name) {
  const n = String(name || '').trim().toLowerCase();
  return n === 'gemini' ? 'google' : n;
}

export function getProvider(name) {
  const p = PROVIDERS[normalizeProvider(name)];
  if (!p) throw new AIError(`Unknown AI provider "${name}" (use ${PROVIDER_NAMES.join(', ')})`, { kind: 'config' });
  return p;
}
