// Build-time snapshot of /config.toml, injected by the `app-config` plugin
// in vite.config.ts. Edit /config.toml (not this file) to rebrand for a
// new exam — Vite full-reloads on save in dev.

export type GroupSpec = { label: string; count: number };

export type AppConfig = {
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
  // Telegram 出題機器人的 bot username(不含 @)。空字串 = 隱藏綁定卡片。
  telegram?: { bot_username: string };
  groups: GroupSpec[];
};

declare const __APP_CONFIG__: AppConfig;

export const config: AppConfig = __APP_CONFIG__;

// Build/deploy timestamp of *this* bundle (yyyy-mm-dd hh:mm:ss, deploy-machine
// local time), baked in by the `app-config` plugin. Used as a fallback when the
// live /version.json fetch (the latest deploy's time) isn't reachable.
declare const __BUILD_TIME__: string;

export const buildTime: string =
  typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '';
