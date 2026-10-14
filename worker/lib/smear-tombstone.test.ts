// #272:已否決的寫法留在表上給診斷頁看,再提報不會把它翻回來,
// 判定仍然只吃 status = 'accepted'。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestDb } from './test-d1.ts';
import { proposeTerm } from './smear-proposal.ts';
import { gradeSmear } from './smear-grade.ts';

const DX = 'tomb_dx';

function seed(db: ReturnType<typeof makeTestDb>) {
  db.exec(
    `INSERT INTO smear_dx (id, canonical_long, canonical_abbrev, topic, qtype, created_at)
     VALUES ('${DX}', 'Tombstone Cell', NULL, 'rbc', 'cell', 1)`,
  );
  db.exec(
    `INSERT INTO smear_terms
       (id, dx_id, text, norm, tier, form, status, rationale, proposed_by, created_at, resolved_at)
     VALUES
       ('half-1', '${DX}', 'poikilocyte half marker', 'poikilocyte half marker',
        'half', 'long', 'accepted', NULL, NULL, 1, 1),
       ('rej-1', '${DX}', 'rejected tombstone word', 'rejected tombstone word',
        'half', 'long', 'rejected', 'too broad to score', 'maintainer@example.com', 1, 2)`,
  );
}

test('再提報已否決的寫法回 409,列維持 rejected', async () => {
  const db = makeTestDb();
  seed(db);

  const again = await proposeTerm(db, DX, 'someone@example.com', {
    text: 'Rejected  Tombstone Word',
    tier: 'full',
    form: 'long',
    rationale: 'try again',
  });

  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.status, 409);
  assert.match(again.error, /already proposed and rejected/);
  assert.equal(again.existingTermId, 'rej-1');

  const rows = db.query<{ status: string; rationale: string | null }>(
    `SELECT status, rationale FROM smear_terms
      WHERE dx_id = '${DX}' AND norm = 'rejected tombstone word'`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'rejected');
  assert.equal(rows[0].rationale, 'too broad to score');
});

test('判定只用 accepted,否決字是 miss,半對字仍是 half', () => {
  const db = makeTestDb();
  seed(db);
  const accepted = db.query<{ text: string; tier: 'full' | 'half' | 'lay' }>(
    `SELECT text, tier FROM smear_terms WHERE dx_id = '${DX}' AND status = 'accepted'`,
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].text, 'poikilocyte half marker');

  assert.equal(gradeSmear(['rejected tombstone word'], accepted).tier, 'miss');
  assert.equal(gradeSmear(['poikilocyte half marker'], accepted).tier, 'half');
});

test('墓碑查詢只在診斷詳情,作答三支仍只取 accepted', () => {
  const src = fs.readFileSync(path.resolve('worker/routes/smear.ts'), 'utf8');
  const rejectedHits = src.match(/status = 'rejected'/g) ?? [];
  assert.deepEqual(rejectedHits, ["status = 'rejected'"]);

  const dxAt = src.indexOf('smearRoutes.get("/dx/:id"');
  const searchAt = src.indexOf('smearRoutes.get("/search"');
  assert.ok(dxAt > 0 && searchAt > dxAt, '診斷詳情路由切不出來,這支測試會變空的綠燈');
  const dxHandler = src.slice(dxAt, searchAt);
  assert.match(dxHandler, /status = 'rejected'/);
  assert.equal(src.slice(0, dxAt).includes("status = 'rejected'"), false);

  assert.ok(
    src.includes(
      "SELECT text, tier FROM smear_terms WHERE dx_id = ? AND status = 'accepted'",
    ),
  );
  assert.ok(
    src.includes(
      "SELECT text, tier, form FROM smear_terms WHERE dx_id = ? AND status = 'accepted'",
    ),
  );
});
