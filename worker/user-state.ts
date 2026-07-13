import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

/**
 * Per-user cross-device state — currently just "where you left off" in the
 * 複習 / 全真 sections, so switching computers resumes at the same question
 * or in-progress exam.
 *
 * One SQLite-backed DO instance for everyone (idFromName("main")) — same
 * free-plan pattern as the chat lobby. ~20 users × 2 tiny rows; a per-user
 * DO would be pointless fragmentation. Identity comes from the Worker's
 * Access middleware; the DO never sees an unauthenticated call.
 */

export type Position = { path: string; at: number };
export type Positions = { review: Position | null; exam: Position | null };

export type Section = 'review' | 'exam';

export function isSection(v: unknown): v is Section {
  return v === 'review' || v === 'exam';
}

export class UserState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        email   TEXT NOT NULL,
        section TEXT NOT NULL,
        path    TEXT NOT NULL,
        at      INTEGER NOT NULL,
        PRIMARY KEY (email, section)
      );
    `);
  }

  getPositions(email: string): Positions {
    const rows = this.ctx.storage.sql
      .exec<{ section: string; path: string; at: number }>(
        'SELECT section, path, at FROM positions WHERE email = ?',
        email,
      )
      .toArray();
    const out: Positions = { review: null, exam: null };
    for (const r of rows) {
      if (isSection(r.section)) out[r.section] = { path: r.path, at: r.at };
    }
    return out;
  }

  setPosition(email: string, section: Section, path: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO positions (email, section, path, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email, section) DO UPDATE SET path = excluded.path, at = excluded.at`,
      email,
      section,
      path,
      Date.now(),
    );
  }

  clearPosition(email: string, section: Section): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM positions WHERE email = ? AND section = ?',
      email,
      section,
    );
  }
}
