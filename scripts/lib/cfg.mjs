// Shared config reader. Loads /config.toml from repo root and exposes
// values to scripts, CLI helpers, and package.json glue.
//
// Usage from a script:
//   import { CFG, cfg } from './lib/cfg.mjs';
//   const dbName = cfg('project.d1_db');
//
// Usage from the shell (package.json scripts, bash):
//   node scripts/lib/cfg.mjs project.d1_db
//
// The parser handles the flat `[section] key = "value"` shape currently
// in config.toml. If config.toml grows arrays / multi-line strings, swap
// in `smol-toml` as a devDependency.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CONFIG_PATH = resolve(ROOT, 'config.toml');

function parseToml(input) {
  const out = {};
  let section = '';
  for (const rawLine of input.split('\n')) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const hdr = line.match(/^\[([A-Za-z_][\w.-]*)\]$/);
    if (hdr) {
      section = hdr[1];
      out[section] ||= {};
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w.-]*)\s*=\s*"((?:[^"\\]|\\.)*)"$/);
    if (kv && section) {
      out[section][kv[1]] = kv[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return out;
}

function loadConfig() {
  try {
    return parseToml(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(
        '✖ config.toml not found at repo root.\n' +
          '  Run `cp config.example.toml config.toml` (or ./scripts/setup.sh) first.',
      );
      process.exit(2);
    }
    throw e;
  }
}

export const CFG = loadConfig();

export function cfg(path) {
  const parts = path.split('.');
  let v = CFG;
  for (const p of parts) {
    if (v == null) return undefined;
    v = v[p];
  }
  return v;
}

// CLI: `node scripts/lib/cfg.mjs <key.path>` — prints the value.
if (import.meta.url === `file://${process.argv[1]}`) {
  const key = process.argv[2];
  if (!key) {
    console.error('Usage: node scripts/lib/cfg.mjs <key.path>   e.g. project.d1_db');
    process.exit(1);
  }
  const v = cfg(key);
  if (v === undefined) {
    console.error(`✖ config key not found: ${key}`);
    process.exit(3);
  }
  process.stdout.write(String(v));
}
