import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.toml');

// Build/deploy timestamp, computed once at config load, and emitted as
// /version.json so a running tab can show how fresh the waiting version is in
// the "new version" prompt.
//
// Two fields, on purpose:
//
//   buildTime     the deploy machine's wall clock, no timezone. Kept only so
//                 tabs still running an *older* bundle (i.e. everyone who sees
//                 the update prompt right after a deploy) keep rendering what
//                 they know how to render.
//   buildTimeIso  UTC ISO-8601 — a real instant. Every current reader uses this
//                 one: it survives a deploy box in another timezone, and it's
//                 the only way to compute "N 小時前". See lib/deployTime.ts.
const BUILD_DATE = new Date();

const BUILD_TIME = ((d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
})(BUILD_DATE);

const BUILD_TIME_ISO = BUILD_DATE.toISOString();

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
  telegram?: { bot_username: string };
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
      return {
        define: {
          __APP_CONFIG__: JSON.stringify(cfg),
          __BUILD_TIME__: JSON.stringify(BUILD_TIME),
          __BUILD_TIME_ISO__: JSON.stringify(BUILD_TIME_ISO),
        },
      };
    },
    // Emit /version.json (never precached — not in the SW glob), so the running
    // tab can fetch the *latest deployed* build time for the update prompt.
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({
          buildTime: BUILD_TIME,
          buildTimeIso: BUILD_TIME_ISO,
        }),
      });
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

// PWA: installable manifest + a hand-written service worker.
//
// `injectManifest` (not `generateSW`) is deliberate. generateSW's
// navigateFallback is cache-first, which would happily serve a precached
// index.html forever — including to a user whose Cloudflare Access session
// has expired, who then never sees the Access login redirect. src/sw.ts
// implements NetworkOnly navigation + an explicit cacheability guard
// instead. See docs/plans/2026-07-20-pwa-offline.md.
function pwaPlugin(): Plugin[] {
  return VitePWA({
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts',
    // Show a "new version" prompt rather than silently taking over: an
    // already-loaded tab references hashed chunks that the new deploy no
    // longer has, so auto-skipWaiting turns lazy routes into blank pages.
    registerType: 'prompt',
    // Registration lives in src/lib/pwa.ts — avoids shipping an extra
    // /registerSW.js that would need its own Access bypass.
    injectRegister: null,
    // Brand strings come from config.toml via the same bootConfig the rest
    // of the app uses. Colours mirror tailwind.config.js.
    manifest: {
      name: bootConfig.brand.long_title,
      short_name: bootConfig.brand.short_name,
      description: bootConfig.brand.subtitle,
      lang: 'zh-TW',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f7f5f2', // ink-50
      theme_color: '#a8442a', // accent.DEFAULT
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        {
          src: '/icons/icon-512-maskable.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },
    injectManifest: {
      // build.sourcemap is on, so .map files must never enter the precache
      // manifest. The lecture reader's chunks — including EmbedPDF's
      // *-engine / browser-* bundles, ~1 MB together — are lazy-loaded and
      // useless offline anyway (pdfium.wasm and the CJK fonts come from
      // cdn.jsdelivr.net at runtime, see public/_headers). manual.html and
      // og-image.png are large public-landing assets, not app shell.
      globPatterns: ['**/*.{js,css,html,svg,woff2}'],
      globIgnores: [
        '**/*.map',
        'manual.html',
        'og-image.png',
        '**/*[Ll]ecture*',
        '**/*-engine-*.js',
        '**/browser-*.js',
        // The kill switch must always come from the network, never a cache.
        'sw-kill.js',
      ],
      maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
    },
    // Keep the SW out of `vite dev` — a stale registration hijacking HMR is
    // a miserable debugging experience. Test it via `pnpm build && pnpm preview`.
    devOptions: { enabled: false },
  });
}

// wrangler dev 預設 8787,但那個 port 常被其他本機服務佔走(例如
// OpenEvidence MCP 的 relay daemon)。撞到時用
// `WORKER_PORT=8788 pnpm dev -- --port 8788` 起 wrangler,前端這邊就跟著轉。
const WORKER_ORIGIN = `http://localhost:${process.env.WORKER_PORT || 8787}`;

export default defineConfig({
  plugins: [react(), appConfigPlugin(), pwaPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: WORKER_ORIGIN,
        changeOrigin: true,
        // 聊天大廳 WebSocket (/api/chat/ws) rides the same proxy entry;
        // http-proxy applies `headers` to upgrade requests too.
        ws: true,
        // Local dev only — the Worker accepts this when
        // CF_ACCESS_TEAM_DOMAIN === 'localhost' (see .dev.vars).
        headers: { 'X-Dev-Email': bootConfig.dev.dev_email },
      },
      '/img': {
        target: WORKER_ORIGIN,
        changeOrigin: true,
        headers: { 'X-Dev-Email': bootConfig.dev.dev_email },
      },
      '/pdf': {
        target: WORKER_ORIGIN,
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
