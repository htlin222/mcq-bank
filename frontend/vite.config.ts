import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.toml');

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
};

// Minimal TOML reader — handles the flat `[section] key = "value"` shape
// in /config.toml. If config.toml grows arrays / multi-line strings,
// swap in `smol-toml` as a devDependency.
function parseToml(input: string): AppConfig {
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
  return out as unknown as AppConfig;
}

function loadConfig(): AppConfig {
  return parseToml(readFileSync(CONFIG_PATH, 'utf8'));
}

// Replace %CONFIG_*% tokens in index.html with values from config.toml
// and rebuild whenever the file changes in dev.
function appConfigPlugin(): Plugin {
  let cfg = loadConfig();
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
        headers: { 'X-Dev-Email': 'ppoiu87@gmail.com' },
      },
      '/img': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        headers: { 'X-Dev-Email': 'ppoiu87@gmail.com' },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
