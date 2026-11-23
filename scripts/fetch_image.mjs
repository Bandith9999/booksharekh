// Image download for the video/poster renderers.
// On the GitHub runner (WORKER_URL, JOB_CALLBACK_SECRET and TASK_ID set) images come through the AI
// Manager's /job-asset route: the website's firewall blocks GitHub servers. Locally they are fetched
// directly. Returns { bytes: Buffer, type } or null; never throws.
const MAX = 8 * 1024 * 1024;
export async function fetchImage(url, maxBytes = MAX) {
  if (!/^https:\/\//.test(url || '')) return null;
  const { WORKER_URL, JOB_CALLBACK_SECRET, TASK_ID } = process.env;
  const viaWorker = WORKER_URL && JOB_CALLBACK_SECRET && TASK_ID;
  const target = viaWorker ? `${WORKER_URL.replace(/\/+$/, '')}/job-asset/${encodeURIComponent(TASK_ID)}?url=${encodeURIComponent(url)}` : url;
  const headers = { 'User-Agent': 'BookShareKH-GitHub-Runner/1.0', ...(viaWorker ? { Authorization: `Bearer ${JOB_CALLBACK_SECRET}` } : {}) };
  try {
    const r = await fetch(target, { headers, signal: AbortSignal.timeout(30000) });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !/^image\/(png|jpe?g|webp|gif)$/.test(type)) { console.log(`image not available (${r.status} ${type}): ${url}`); return null; }
    const bytes = Buffer.from(await r.arrayBuffer());
    return bytes.length && bytes.length <= maxBytes ? { bytes, type } : null;
  } catch (e) { console.log(`image download failed: ${url}: ${e.message}`); return null; }
}
