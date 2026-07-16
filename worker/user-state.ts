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

// Per-year 「你上次停在…」 — the last question opened within a single year,
// remembered separately for each year so switching years doesn't clobber it.
export type YearPosition = { questionId: string; at: number };

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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS year_positions (
        email       TEXT NOT NULL,
        year        INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        at          INTEGER NOT NULL,
        PRIMARY KEY (email, year)
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

  getYearPosition(email: string, year: number): YearPosition | null {
    const row = this.ctx.storage.sql
      .exec<{ question_id: string; at: number }>(
        'SELECT question_id, at FROM year_positions WHERE email = ? AND year = ?',
        email,
        year,
      )
      .toArray()[0];
    return row ? { questionId: row.question_id, at: row.at } : null;
  }

  setYearPosition(email: string, year: number, questionId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO year_positions (email, year, question_id, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email, year) DO UPDATE SET question_id = excluded.question_id, at = excluded.at`,
      email,
      year,
      questionId,
      Date.now(),
    );
  }

  clearYearPosition(email: string, year: number): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM year_positions WHERE email = ? AND year = ?',
      email,
      year,
    );
  }
}
