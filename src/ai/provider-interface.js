// Provider-neutral contract. Every adapter in this folder implements it.
//
// AIRequest {
//   agent: string                     registry name, for logs and the mock provider
//   systemPrompt: string
//   messages: [{ role: 'user'|'assistant', content: string }]
//   model: string                     provider model id, already validated by the router
//   maxOutputTokens?: number          includes reasoning/thinking tokens on providers that count them
//   temperature?: number              sent only to providers/models that accept it
//   effort?: 'low'|'medium'|'high'    reasoning depth hint; ignored where unsupported
//   responseSchema?: object           JSON Schema; the response is parsed and validated against it
//   metadata?: object                 never sent to a provider
// }
//
// AIResponse {
//   provider: string, model: string  model = what actually served the request
//   content: string, structuredOutput?: unknown,
//   usage: { inputTokens: number, outputTokens: number }, finishReason: string
// }
//
// Adapter shape: { name, keyName, modelPattern, generate(env, request), checkModel(env, model) }
// Adapters throw AIError (./errors.js) and never switch provider or model on their own.

export function makeResponse({ provider, model, content, structuredOutput, inputTokens = 0, outputTokens = 0, finishReason = 'stop' }) {
  return { provider, model, content, structuredOutput, usage: { inputTokens, outputTokens }, finishReason };
}
