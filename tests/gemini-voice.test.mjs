// Gemini text-to-speech for promo videos: both Google request shapes, WAV output, the paid-key lock,
// and /job-voice speaks only the approved scene of a running promo task.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockFetch, worker } from './harness.mjs';
import { TtsError, findAudio, geminiSpeech, pcmToWav } from '../src/ai/gemini-tts.js';
import { addArtifact } from '../src/db.js';

const pcm = new Uint8Array(4800).fill(7);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const wavB64 = b64(pcmToWav(pcm));

test('audio is found in both response shapes and raw PCM becomes WAV', () => {
  assert.equal(findAudio({ steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: wavB64 }] }] }).data, wavB64);
  assert.equal(findAudio({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: b64(pcm) } }] } }] }).mime, 'audio/L16;codec=pcm;rate=24000');
  const wav = pcmToWav(pcm);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 24000);
});

test('Interactions API first; classic generateContent when it is not available', async () => {
  const env = makeEnv({ GEMINI_API_KEY: 'g-key' });
  const calls = mockFetch([
    [/\/v1beta\/interactions$/, () => Response.json({ error: { message: 'not found' } }, { status: 404 })],
    [/:generateContent$/, () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: b64(pcm) } }] } }] })],
  ]);
  const r = await geminiSpeech(env, 'ចូលអានឥឡូវនេះ', { style: 'warm' });
  assert.equal(String.fromCharCode(...r.wav.slice(0, 4)), 'RIFF');
  assert.equal(r.model, 'gemini-3.8-flash-tts');
  assert.equal(calls[0].body.generation_config.speech_config[0].voice, 'Sulafat');
  assert.equal(calls[0].body.input[0].content[0].text, 'ចូលអានឥឡូវនេះ', 'the transcript is sent verbatim');
  assert.equal(calls[1].body.generationConfig.responseModalities[0], 'AUDIO');
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'g-key');
});

test('a paid Gemini project is not used while paid AI is locked; no key means no call', async () => {
  const calls = mockFetch([]);
  await assert.rejects(geminiSpeech(makeEnv({ GEMINI_API_KEY: 'k', GEMINI_PAID_TIER: 'true' }), 'x'), TtsError);
  await assert.rejects(geminiSpeech(makeEnv(), 'x'), /GEMINI_API_KEY/);
  assert.equal(calls.length, 0);
});

test('/job-voice: only the approved scene of a running promo task, only for the runner', async () => {
  const env = makeEnv({ GEMINI_API_KEY: 'g-key', PROMO_TTS_VOICE: 'Kore' });
  const id = 'BSK-11111111-2222-4333-8444-555555555555';
  env.DB.db.prepare("INSERT INTO tasks (id,telegram_user_id,request_text,task_type,proposal,status) VALUES (?,?,?,?,?,?)").run(id, '111', 'promo', 'book_promo', 'p', 'running');
  await addArtifact(env, { taskId: id, kind: 'promo', content: JSON.stringify({ videos: [{ voice_style: 'calm', scenes: [{ text: 'a', voice: 'សួស្តី' }, { text: 'b', voice: 'លាហើយ' }] }] }) });
  const calls = mockFetch([[/\/v1beta\/interactions$/, () => Response.json({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: wavB64 }] }] })]]);
  const get = (path, auth = 'Bearer cb-secret') => worker.fetch(new Request(`https://w.example${path}`, { headers: auth ? { Authorization: auth } : {} }), env);

  assert.equal((await get(`/job-voice/${id}/1`, null)).status, 401);
  const r = await get(`/job-voice/${id}/1`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(calls.at(-1).body.input[0].content[0].text, 'លាហើយ', 'speaks the approved voice line');
  assert.equal(calls.at(-1).body.input[0].content[0].annotations[0].style, 'calm');
  assert.equal(calls.at(-1).body.generation_config.speech_config[0].voice, 'Kore');
  assert.equal((await get(`/job-voice/${id}/5`)).status, 400, 'no such scene');

  env.DB.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(id);
  assert.equal((await get(`/job-voice/${id}/0`)).status, 409, 'finished tasks get nothing');

  env.DB.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(id);
  mockFetch([[/generativelanguage/, () => Response.json({ error: { message: 'quota' } }, { status: 429 })]]);
  const fail = await get(`/job-voice/${id}/0`);
  assert.equal(fail.status, 502, 'the runner then uses its fallback voice');
});
