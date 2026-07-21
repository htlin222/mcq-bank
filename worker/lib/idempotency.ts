import type { Context } from 'hono';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { AppContext } from '../types';

/** 標準命名的請求去重 header。對 JSON 與 multipart(upload)都適用。 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** key 上限。夠長容納 UUID / nanoid,又不讓惡意 client 塞爆 PK。 */
export const MAX_IDEM_KEY_LEN = 128;

/** 驗證 raw key:非空且 ≤128 字元才回傳(trim 後),否則 null。 */
export function validateIdemKey(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (!key || key.length > MAX_IDEM_KEY_LEN) return null;
  return key;
}

/** 以 user_email 前綴命名空間化,避免跨使用者的 key 碰撞。存進 PK 的實際值。 */
export function dedupPk(email: string, key: string): string {
  return `${email}:${key}`;
}

/** 讀 header 並驗證。呼叫端拿到的是 raw key(未命名空間化);沒帶 / 不合法 → null。 */
export function readIdemKey(c: Context<AppContext>): string | null {
  return validateIdemKey(c.req.header(IDEMPOTENCY_HEADER));
}

/** 命中去重列時回傳 replay 內容:status 與已 JSON.parse 的 body;沒命中 → null。 */
export async function idemLookup(
  db: D1Database,
  email: string,
  key: string,
): Promise<{ status: number; body: unknown } | null> {
  const row = await db
    .prepare('SELECT status, response_json FROM request_dedup WHERE client_id = ?')
    .bind(dedupPk(email, key))
    .first<{ status: number; response_json: string }>();
  if (!row) return null;
  let body: unknown = null;
  try {
    body = JSON.parse(row.response_json);
  } catch {
    body = null;
  }
  return { status: row.status, body };
}

/** 產生去重列的 INSERT statement(不執行),供併進既有的 DB.batch()。
 *  INSERT OR IGNORE:同一 key 已存在就不覆寫,並發雙發時只保留第一筆。 */
export function idemRecordOp(
  db: D1Database,
  args: {
    email: string;
    key: string;
    endpoint: string;
    status: number;
    body: unknown;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO request_dedup
       (client_id, user_email, endpoint, status, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      dedupPk(args.email, args.key),
      args.email,
      args.endpoint,
      args.status,
      JSON.stringify(args.body),
      args.now,
    );
}
