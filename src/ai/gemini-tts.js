// Khmer voice-over with Gemini text-to-speech (Google AI Studio key: secret GEMINI_API_KEY).
// The video job on GitHub asks the Worker for one approved scene at a time (/job-voice), so the key
// never leaves Cloudflare and only text the owner approved is ever spoken.
// Google documents two request shapes; the newer Interactions API is tried first, then the classic
// generateContent shape. Output: a WAV file (24 kHz mono 16-bit PCM).
import { paidEnabled } from './model-router.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const TTS_MODEL = 'gemini-3.8-flash-tts';
// Prebuilt Gemini voices (name: character). Any of these can be set with PROMO_TTS_VOICE.
export const TTS_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel',
  'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird',
  'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
export const TTS_DEFAULT_VOICE = 'Sulafat'; // warm
const DEFAULT_STYLE = 'warm, friendly and upbeat, like a young Cambodian presenter on TikTok; clear Khmer pronunciation; natural pace';

export class TtsError extends Error {}

export function ttsSettings(env) {
  const voice = TTS_VOICES.includes(env.PROMO_TTS_VOICE) ? env.PROMO_TTS_VOICE : TTS_DEFAULT_VOICE;
  const model = /^gemini-[a-z0-9.-]{1,60}-tts(-preview)?$/.test(env.PROMO_TTS_MODEL || '') ? env.PROMO_TTS_MODEL : TTS_MODEL;
  return { voice, model };
}

// Find the first audio payload in either response shape (steps[].content[] or candidates[].content.parts[].inlineData).
export function findAudio(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  const mime = node.mime_type || node.mimeType || '';
  if (typeof node.data === 'string' && node.data.length > 100 && (node.type === 'audio' || /^audio\//i.test(mime))) return { data: node.data, mime: mime || 'audio/wav' };
  for (const v of Array.isArray(node) ? node : Object.values(node)) { const f = findAudio(v, depth + 1); if (f) return f; }
  return null;
}

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
// Raw 16-bit little-endian PCM → WAV.
export function pcmToWav(pcm, rate = 24000, channels = 1) {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); h.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt ');
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, channels, true); h.setUint32(24, rate, true);
  h.setUint32(28, rate * channels * 2, true); h.setUint16(32, channels * 2, true); h.setUint16(34, 16, true);
  w(36, 'data'); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(h.buffer), 0); out.set(pcm, 44);
  return out;
}
export function toWav({ data, mime }) {
  const bytes = b64(data);
  if (/wav/i.test(mime) || String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF') return bytes;
  return pcmToWav(bytes, Number(/rate=(\d+)/i.exec(mime)?.[1]) || 24000);
}

async function post(env, path, body) {
  const r = await fetch(`${BASE}/${path}`, {
    method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
  });
  const json = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, json };
}

// Returns WAV bytes for one short Khmer line. Throws TtsError (the video job then uses its fallback voice).
export async function geminiSpeech(env, text, { style = '' } = {}) {
  if (!env.GEMINI_API_KEY) throw new TtsError('GEMINI_API_KEY is not set');
  // A paid Gemini project costs money per second of audio: only when the owner unlocked paid AI.
  if (env.GEMINI_PAID_TIER === 'true' && !paidEnabled(env)) throw new TtsError('Gemini key is on a paid project and paid AI is locked');
  const { voice, model } = ttsSettings(env);
  const tone = String(style || DEFAULT_STYLE).slice(0, 160);
  const line = String(text || '').trim().slice(0, 400);
  if (!line) throw new TtsError('empty text');

  const tries = [
    ['interactions', {
      model, input: [{ type: 'user_input', content: [{ type: 'text', text: line, annotations: [{ type: 'speech_metadata', style: tone }] }] }],
      response_format: { type: 'audio', mime_type: 'audio/wav' }, generation_config: { speech_config: [{ voice }] },
    }],
    [`models/${model}:generateContent`, {
      contents: [{ parts: [{ text: `Read this Khmer line aloud in a ${tone} voice. Say only the line:\n${line}` }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }],
  ];
  let last = '';
  for (const [path, body] of tries) {
    let res;
    try { res = await post(env, path, body); } catch (e) { last = `network: ${e.message}`; continue; }
    const audio = res.ok ? findAudio(res.json) : null;
    if (audio) { const wav = toWav(audio); if (wav.length > 2000) return { wav, voice, model }; }
    last = `HTTP ${res.status}${res.json?.error?.message ? `: ${String(res.json.error.message).slice(0, 160)}` : ''}`;
    if (res.status === 401 || res.status === 403 || res.status === 429) break; // same key and quota for both shapes
  }
  throw new TtsError(`Gemini TTS failed (${last})`);
}
