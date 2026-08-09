// 給單元測試用的 D1 替身:一顆 in-memory SQLite(node:sqlite)包上 D1 的介面。
//
// 為什麼不是手寫 stub:這支要驗的是**順序語意** —— 同一題有兩個進行中的挑戰,
// 其中一個 promote 之後另一個必須在同一次呼叫裡消失。那條行為橫跨
// `answer_challenges` / `challenge_votes` / `questions` / `answer_history` 四張表
// 與一個 `db.batch()`,手寫 stub 等於把待驗的邏輯再實作一次,綠燈只證明兩份
// 實作長得像。真的建一顆 SQLite 並跑真的 migrations,錯的 SQL 會直接炸。
//
// 覆蓋的是 D1 用到的那一小塊介面(prepare/bind/first/all/run/batch)。刻意不做
// 完整模擬 —— 沒用到的就不要假裝支援,免得下次有人以為它是通用替身。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, '..', '..', 'migrations');

type Row = Record<string, unknown>;

// node:sqlite hands back null-prototype rows; D1 hands back plain objects.
// Normalise so assertions (and any `instanceof`/prototype-sensitive code) see
// the same shape they would in production.
function plain<T>(row: unknown): T {
  return (row == null ? row : { ...(row as object) }) as T;
}

function meta() {
  return { duration: 0, changes: 0, last_row_id: 0, rows_read: 0, rows_written: 0 };
}

class Stmt {
  #db: DatabaseSync;
  #sql: string;
  #args: unknown[];

  constructor(db: DatabaseSync, sql: string, args: unknown[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#args = args;
  }

  bind(...args: unknown[]) {
    return new Stmt(this.#db, this.#sql, args);
  }

  get text() {
    return this.#sql;
  }

  async first<T = Row>(): Promise<T | null> {
    const row = this.#db.prepare(this.#sql).get(...(this.#args as any[]));
    return row === undefined ? null : plain<T>(row);
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: ReturnType<typeof meta> }> {
    const rows = this.#db.prepare(this.#sql).all(...(this.#args as any[]));
    return { results: rows.map((r: unknown) => plain<T>(r)), success: true, meta: meta() };
  }

  async run() {
    this.#db.prepare(this.#sql).run(...(this.#args as any[]));
    return { results: [], success: true as const, meta: meta() };
  }

  /** batch() runs statements itself; this is the synchronous half. */
  execSync() {
    this.#db.prepare(this.#sql).run(...(this.#args as any[]));
  }
}

class FakeD1 {
  /**
   * Every SQL string handed to prepare(), in order. This is the instrument for
   * the round-trip assertions: D1 has no client-side batching, so one prepare()
   * outside a batch() is one sequential trip to the binding.
   */
  readonly queries: string[] = [];

  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(sql: string) {
    this.queries.push(sql.replace(/\s+/g, ' ').trim());
    return new Stmt(this.#db, sql);
  }

  async batch(stmts: any[]) {
    // D1 wraps a batch in an implicit transaction. Mirror that so a failing
    // statement can't leave half a promote behind.
    this.#db.exec('BEGIN');
    try {
      for (const s of stmts) (s as Stmt).execSync();
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    return stmts.map(() => ({ results: [], success: true as const, meta: meta() }));
  }

  /** Escape hatch for test setup/inspection — not part of the D1 surface. */
  exec(sql: string) {
    this.#db.exec(sql);
  }

  query<T = Row>(sql: string, ...args: unknown[]): T[] {
    return this.#db.prepare(sql).all(...(args as any[])).map((r: unknown) => plain<T>(r));
  }
}

export type TestD1 = FakeD1 & D1Database;

/** Fresh in-memory DB with every migration in `migrations/` applied in order. */
export function makeTestDb(): TestD1 {
  const db = new DatabaseSync(':memory:');
  const files: string[] = fs
    .readdirSync(MIGRATIONS)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
  return new FakeD1(db) as unknown as TestD1;
}
