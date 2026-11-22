#!/usr/bin/env node
// Builds a clean copy of the Laravel source for the private GitHub repository.
//   node website-kit/prepare-export.mjs <extracted-cpanel-folder> <clean-output-folder>
// Copies only source files (never .env, vendor, logs, caches, sessions, uploads, dumps),
// creates .env.example with key NAMES only if missing, and scans the copy for secrets.
// It never modifies the input folder. Exit code 2 = secrets found: fix them before pushing.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const EXCLUDE = [
  /^\.env(\..*)?$/, /^vendor(\/|$)/, /^node_modules(\/|$)/, /^storage\/logs(\/|$)/, /^storage\/framework(\/|$)/,
  /^storage\/app(\/|$)/, /^storage\/debugbar(\/|$)/, /^public\/storage(\/|$)/, /^public\/uploads(\/|$)/, /^bootstrap\/cache\/.*\.php$/,
  // BookShareKH uploads: book files and covers live under public/images (content, not code).
  /^public\/images\/(files|covers)(\/|$)/, /^\.phpunit\.result\.cache$/,
  /^\.git(\/|$)/, /(^|\/)(error_log|\.DS_Store)$/, /\.(sql|sql\.gz|sqlite|zip|tar|tgz|gz|bak|log)$/i, /^public\/hot$/,
];
const KEEP_ANYWAY = [/^\.env\.example$/];
export const SECRET_PATTERNS = [
  [/APP_KEY=base64:[A-Za-z0-9+/=]{20,}/, 'Laravel APP_KEY'],
  // Placeholders (null, empty, ${VAR}) and Laravel validation rules ('required|...') are not secrets.
  [/(DB_PASSWORD|MAIL_PASSWORD|AWS_SECRET_ACCESS_KEY|GOOGLE_CLIENT_SECRET|PUSHER_APP_SECRET)\s*=\s*['"]?(?!null\b|\$\{)[^\s'"$]{4,}/, 'credential assignment'],
  [/['"](password|secret|client_secret|api_key)['"]\s*=>\s*['"](?!(required|nullable|sometimes|confirmed|string|min:|max:|password|secret|test|wrong-password|new-password)\b)[^'"$|]{6,}['"]/i, 'hard-coded secret in PHP array'],
  [/sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|GOCSPX-[A-Za-z0-9_-]{10,}/, 'API key/token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
];
const TEXT = /\.(php|js|ts|json|ya?ml|env\.example|md|txt|blade\.php|xml|ini|conf|htaccess|sh|vue|css|scss)$|^\.htaccess$|(^|\/)\.env\.example$/i;

const norm = p => p.split(sep).join('/');
export const isExcluded = rel => !KEEP_ANYWAY.some(r => r.test(rel)) && EXCLUDE.some(r => r.test(rel));

export function prepareExport(src, dest) {
  if (!existsSync(join(src, 'artisan')) || !existsSync(join(src, 'composer.json'))) throw new Error(`${src} does not look like a Laravel root (artisan and composer.json not found)`);
  if (existsSync(dest) && readdirSync(dest).length) throw new Error(`${dest} must be empty or not exist`);
  mkdirSync(dest, { recursive: true });
  const copied = [], skipped = [], findings = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name), rel = norm(relative(src, abs));
      const st = statSync(abs);
      if (isExcluded(rel + (st.isDirectory() ? '/' : ''))) { skipped.push(rel); continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      cpSync(abs, join(dest, rel));
      copied.push(rel);
      if (TEXT.test(rel) && st.size < 2_000_000) {
        const lines = readFileSync(abs, 'utf8').split('\n');
        lines.forEach((line, i) => { // one finding per line
          const hit = SECRET_PATTERNS.find(([re]) => re.test(line));
          if (hit) findings.push({ file: rel, line: i + 1, what: hit[1] });
        });
      }
    }
  };
  walk(src);
  // Laravel needs these (empty) runtime folders to exist; recreate the standard skeleton.
  for (const d of ['storage/app/public', 'storage/framework/cache/data', 'storage/framework/sessions', 'storage/framework/testing', 'storage/framework/views', 'storage/logs']) {
    mkdirSync(join(dest, d), { recursive: true });
    writeFileSync(join(dest, d, '.gitignore'), d === 'storage/app/public' ? '*\n!.gitignore\n' : '*\n!.gitignore\n');
  }
  // .env.example with key names only (values are never copied).
  if (!existsSync(join(dest, '.env.example')) && existsSync(join(src, '.env'))) {
    const keys = readFileSync(join(src, '.env'), 'utf8').split('\n').map(l => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1]).filter(Boolean);
    writeFileSync(join(dest, '.env.example'), keys.map(k => `${k}=${k === 'APP_ENV' ? 'production' : k === 'APP_DEBUG' ? 'false' : ''}`).join('\n') + '\n');
    copied.push('.env.example (generated: names only)');
  }
  return { copied, skipped, findings };
}

if (process.argv[1] && process.argv[1].endsWith('prepare-export.mjs')) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) { console.error('Usage: node website-kit/prepare-export.mjs <cpanel-copy> <clean-output>'); process.exit(1); }
  const r = prepareExport(src, dest);
  console.log(`Copied ${r.copied.length} files, skipped ${r.skipped.length} paths (env, vendor, logs, caches, uploads, dumps).`);
  if (r.findings.length) {
    console.log(`\nSECRETS FOUND (${r.findings.length}). Move them to .env, then rotate them:`);
    for (const f of r.findings.slice(0, 50)) console.log(`  ${f.file}:${f.line}  ${f.what}`);
    process.exit(2);
  }
  console.log('Secret scan: clean.');
}
