// Build-time snapshot of /config.toml, injected by the `app-config` plugin
// in vite.config.ts. Edit /config.toml (not this file) to rebrand for a
// new exam — Vite full-reloads on save in dev.

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
};

declare const __APP_CONFIG__: AppConfig;

export const config: AppConfig = __APP_CONFIG__;
