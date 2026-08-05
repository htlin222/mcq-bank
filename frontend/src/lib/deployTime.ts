// 「有新版本可用」那條提示上的部署時間。
//
// 為什麼需要一個模組來做這件事:version.json 原本只有 buildTime,一個
// **不帶時區**的本地時間字串("2026-08-05 15:28:50")。它是部署機器當下的
// 牆上時鐘,所以:
//
//   • 讀的人無從得知那是哪個時區的 15:28 —— 手機在國外就完全對不上;
//   • 沒有偏移量就沒有「那一瞬間」,算不出「幾小時前」。
//
// 所以 vite.config.ts 另外發一個 buildTimeIso(UTC 的 ISO-8601)。有它就一律
// 換算成台北時間顯示並附上相對時間;沒有(舊版 version.json)就退回原字串,
// 寧可少說也不要說錯。

const TZ = 'Asia/Taipei';
const TZ_LABEL = 'GMT+8';

const WALL_CLOCK = new Intl.DateTimeFormat('zh-TW', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * Intl 會在日期和時間之間塞一個特殊空白 —— 這台 Node 是 U+2009(thin space),
 * 別的 ICU 版本 / 瀏覽器可能給 U+202F 或普通空格。全部收斂成普通空格,輸出才
 * 不會隨執行環境漂移(也才對得起這行的 tabular-nums)。
 */
function normalizeSpaces(s: string): string {
  return s.replace(/\p{Zs}/gu, ' ');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 相對時間。未來的時間戳(部署機和讀的人時鐘不同步時會發生)一律當成「剛剛」,
 * 而不是「-1 小時前」這種讀起來像壞掉的字。
 */
export function relativeTime(deployedMs: number, now: number): string {
  const diff = now - deployedMs;
  if (diff < MINUTE) return '剛剛';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分鐘前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小時前`;
  return `${Math.floor(diff / DAY)} 天前`;
}

/**
 * 部署時間那一行的完整文字。無法辨識就回空字串 —— 呼叫端據此整行不畫,
 * 而不是留一個孤零零的「部署」。
 */
export function formatDeployedAt(
  info: { buildTime?: string; buildTimeIso?: string } | null | undefined,
  now: number = Date.now(),
): string {
  const ms = info?.buildTimeIso ? Date.parse(info.buildTimeIso) : Number.NaN;
  if (!Number.isNaN(ms)) {
    const wall = normalizeSpaces(WALL_CLOCK.format(ms));
    return `${wall} (${TZ_LABEL}) · ${relativeTime(ms, now)}`;
  }
  // 舊版 version.json:只有那串沒有時區的本地時間。原樣印出,不加也不敢加
  // 「幾小時前」—— 猜錯時區會讓相對時間差上大半天。
  return info?.buildTime?.trim() || '';
}
