export function classifyTask(s) {
  return /video|tiktok|reel|វីដេអូ/i.test(s) ? 'video_demo' : 'report';
}
export function clamp(text, n=3500) {
  return String(text || '').slice(0, n);
}
export function parseMemory(message) {
  const m = /^\/remember\s+([a-zA-Z0-9_.-]{1,80})=(.{1,1000})$/s.exec(message.trim());
  return m ? { key: m[1], value: m[2].trim() } : null;
}
export function isOwner(actual, owner) {
  return String(actual) === String(owner) && String(owner) !== 'REPLACE_WITH_TELEGRAM_NUMERIC_ID';
}
export function safeTaskId(s) {
  return /^BSK-[a-f0-9-]{36}$/.test(String(s));
}
