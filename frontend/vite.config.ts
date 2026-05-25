import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.toml');

type GroupSpec = { label: string; count: number };

type AppConfig = {
  brand: {
    short_name: string;
    year: string;
    long_title: string;
    subtitle: string;
    home_subtitle: string;
  };
  exam: { date_iso: string; date_label: string; countdown_label: string };
  public: { host: string; og_invite_line: string };
  storage: { theme_storage_key: string };
  dev: { dev_email: string };
  // Pre-parsed from [groups].list so frontend code never has to parse
  // "<label>:<count>,..." at runtime. See frontend/src/lib/groups.ts.
  groups: GroupSpec[];
};

// Minimal TOML reader — handles the flat `[section] key = "value"` shape
// in /config.toml. If config.toml grows arrays / multi-line strings,
// swap in `smol-toml` as a devDependency.
function parseToml(input: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
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

// Parse `Section A:50,Section B:50` → [{label, count}, ...].
function parseGroupsList(raw: string): GroupSpec[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const sep = part.lastIndexOf(':');
      if (sep < 0) return { label: part, count: 0 };
      const label = part.slice(0, sep).trim();
      const count = Number(part.slice(sep + 1).trim()) || 0;
      return { label, count };
    });
}

function loadConfig(): AppConfig {
  const raw = parseToml(readFileSync(CONFIG_PATH, 'utf8'));
  const groupsRaw = raw.groups?.list ?? '';
  return {
    ...(raw as unknown as Omit<AppConfig, 'groups'>),
    groups: parseGroupsList(groupsRaw),
  };
}

// Loaded once at startup so the dev proxy below can reuse the same
// dev_email. The plugin re-reads on change for HMR; the proxy header is
// fixed for the lifetime of the dev server (restart to change it).
const bootConfig = loadConfig();

// Replace %CONFIG_*% tokens in index.html with values from config.toml
// and rebuild whenever the file changes in dev.
function appConfigPlugin(): Plugin {
  let cfg = bootConfig;
  return {
    name: 'app-config',
    config() {
      return { define: { __APP_CONFIG__: JSON.stringify(cfg) } };
    },
    configureServer(server) {
      server.watcher.add(CONFIG_PATH);
      server.watcher.on('change', (file) => {
        if (path.resolve(file) !== CONFIG_PATH) return;
        cfg = loadConfig();
        server.config.logger.info('[app-config] config.toml changed — reloading');
        server.ws.send({ type: 'full-reload' });
      });
    },
    transformIndexHtml(html) {
      return html
        .replace(/%CONFIG_TITLE%/g, cfg.brand.long_title)
        .replace(/%CONFIG_DESCRIPTION%/g, cfg.brand.subtitle)
        .replace(/%CONFIG_OG_URL%/g, `https://${cfg.public.host}/`)
        .replace(/%CONFIG_OG_IMAGE%/g, `https://${cfg.public.host}/og-image.png`);
    },
  };
}

export default defineConfig({
  plugins: [react(), appConfigPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // Local dev only — the Worker accepts this when
        // CF_ACCESS_TEAM_DOMAIN === 'localhost' (see .dev.vars).
        headers: { 'X-Dev-Email': bootConfig.dev.dev_email },
      },
      '/img': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        headers: { 'X-Dev-Email': bootConfig.dev.dev_email },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
