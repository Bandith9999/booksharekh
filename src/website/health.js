// Read-only public health and exposure check of the live website. Never reads or reports the body of
// a sensitive path: only status codes. Uses about 6 subrequests (Workers Free allows 50).
import { clamp } from '../helpers.js';
import { T } from '../i18n.js';

const UA = 'BookShareKH-AI-Manager-health-check';
const TIMEOUT_MS = 12000;
// Paths that must never be publicly readable on a Laravel site.
export const SENSITIVE_PATHS = ['/.env', '/.git/HEAD', '/storage/logs/laravel.log', '/composer.json'];

export const siteUrl = env => String(env.WEBSITE_URL || 'https://booksharekh.com').replace(/\/+$/, '');

async function probe(url, { readBody = false } = {}) {
  const started = Date.now();
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = readBody ? await r.text().catch(() => '') : (await r.body?.cancel().catch(() => {}), '');
    return { status: r.status, ms: Date.now() - started, body, poweredBy: r.headers.get('x-powered-by') };
  } catch (e) {
    return { status: 0, ms: Date.now() - started, error: e?.name === 'TimeoutError' ? 'timeout' : clamp(e?.message, 80) };
  }
}

// Returns { ok, findings: [{ level: 'ok'|'warn'|'critical', text }] }
export async function checkWebsite(env) {
  const base = siteUrl(env);
  const L = T.health(env);
  const findings = [];
  const home = await probe(`${base}/`);
  if (home.status >= 200 && home.status < 400) findings.push({ level: home.ms > 4000 ? 'warn' : 'ok', text: L.home(home.status, home.ms, home.poweredBy) });
  else findings.push({ level: 'critical', text: L.down(home.status ? `HTTP ${home.status}` : home.error) });

  // Laravel Ignition answers this only when the debug error page is installed and routed.
  const ign = await probe(`${base}/_ignition/health-check`, { readBody: true });
  if (ign.status === 200 && /"can_execute_commands"\s*:\s*true/.test(ign.body)) {
    findings.push({ level: 'critical', text: L.debugOn });
  } else if (ign.status === 200) {
    findings.push({ level: 'warn', text: L.ignition });
  } else findings.push({ level: 'ok', text: L.debugOff });

  let exposed = false;
  for (const p of SENSITIVE_PATHS) {
    const r = await probe(`${base}${p}`);
    if (r.status === 200) { exposed = true; findings.push({ level: 'critical', text: L.exposed(p) }); }
  }
  if (!exposed) findings.push({ level: 'ok', text: L.safe(SENSITIVE_PATHS.join(', ')) });
  return { ok: !findings.some(f => f.level === 'critical'), findings, site: base };
}

const ICON = { ok: '✅', warn: '⚠️', critical: '🚨' };
export function formatHealth(res, env = null) {
  return [T.health(env).head(res.site), ...res.findings.map(f => `${ICON[f.level]} ${f.text}`)].join('\n');
}
