import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('netlify.toml publishes only the public/ directory', () => {
  const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');
  assert.match(toml, /^\s*publish\s*=\s*"public"\s*$/m);
  assert.match(toml, /^\s*functions\s*=\s*"netlify\/functions"\s*$/m);
});

test('published files are only the intended browser assets', () => {
  const files = walk(join(root, 'public')).map(p => p.slice(join(root, 'public').length + 1)).sort();
  assert.deepEqual(files, ['app.js', 'index.html', 'robots.txt']);
});

test('browser assets contain no sheet IDs, API keys, passwords or server config', () => {
  const blob = walk(join(root, 'public')).map(p => readFileSync(p, 'utf8')).join('\n');
  assert.doesNotMatch(blob, /spreadsheets|sheets\.googleapis|AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(blob, /[A-Za-z0-9_-]{40,}/, 'no long opaque tokens');
  assert.doesNotMatch(blob, /SITE_PASSWORD|SESSION_SECRET|GOOGLE_SHEETS_API_KEY|_SHEET_ID|TAB_GID/);
  assert.doesNotMatch(blob, /sessionStorage\.setItem|localStorage\.setItem/);
  assert.doesNotMatch(blob, /x-site-password/i);
  assert.doesNotMatch(blob, /\son[a-z]+\s*=/i, 'no inline event handlers (CSP script-src self)');
  assert.doesNotMatch(blob, /innerHTML/);
});

test('tracked source, tests and config contain no real-looking credentials or sheet IDs', () => {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(f => f && !f.startsWith('node_modules/') && f !== 'package-lock.json');
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{30,}/, `${f}: Google API key`);
    // Google spreadsheet IDs are 44-char base64url strings starting with "1".
    for (const m of text.matchAll(/\b1[A-Za-z0-9_-]{43}\b/g)) {
      assert.fail(`${f}: looks like a spreadsheet ID (${m[0].slice(0, 4)}…)`);
    }
  }
});

test('no committed .env files', () => {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n');
  assert.ok(!files.some(f => /(^|\/)\.env($|\.)/.test(f) && !f.endsWith('.env.example')));
});
