import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIdemKey,
  dedupPk,
  readIdemKey,
  idemRecordOp,
  IDEMPOTENCY_HEADER,
  MAX_IDEM_KEY_LEN,
} from './idempotency.ts';

test('validateIdemKey:空 / 空白 → null', () => {
  for (const v of [undefined, null, '', '   ', 123 as unknown as string])
    assert.equal(validateIdemKey(v), null);
});

test('validateIdemKey:超過上限 → null,剛好上限 → 通過', () => {
  assert.equal(validateIdemKey('x'.repeat(MAX_IDEM_KEY_LEN + 1)), null);
  const atLimit = 'x'.repeat(MAX_IDEM_KEY_LEN);
  assert.equal(validateIdemKey(atLimit), atLimit);
});

test('validateIdemKey:正常值 trim 後原樣回傳', () => {
  assert.equal(validateIdemKey('  abc-123  '), 'abc-123');
  assert.equal(validateIdemKey('550e8400-e29b-41d4-a716-446655440000'),
    '550e8400-e29b-41d4-a716-446655440000');
});

test('dedupPk:以 email 前綴命名空間化', () => {
  assert.equal(dedupPk('a@x.com', 'k1'), 'a@x.com:k1');
  // 不同使用者、同一 raw key → 不同 PK(不會碰撞)
  assert.notEqual(dedupPk('a@x.com', 'k1'), dedupPk('b@x.com', 'k1'));
});

test('readIdemKey:讀對應 header 並驗證', () => {
  const mk = (val: string | undefined) =>
    ({ req: { header: (name: string) => (name === IDEMPOTENCY_HEADER ? val : undefined) } }) as any;
  assert.equal(readIdemKey(mk('key-1')), 'key-1');
  assert.equal(readIdemKey(mk(undefined)), null);
  assert.equal(readIdemKey(mk('  ')), null);
});

test('idemRecordOp:INSERT OR IGNORE + 命名空間化 PK + bind 形狀', () => {
  let sql = '';
  let bound: unknown[] = [];
  const fakeDb = {
    prepare(q: string) {
      sql = q;
      return {
        bind(...args: unknown[]) {
          bound = args;
          return { __stmt: true };
        },
      };
    },
  } as any;

  const stmt = idemRecordOp(fakeDb, {
    email: 'u@x.com',
    key: 'k9',
    endpoint: 'POST /review/answer',
    status: 200,
    body: { correct: true },
    now: 1_700_000_000_000,
  });

  assert.deepEqual(stmt, { __stmt: true });
  assert.match(sql, /INSERT OR IGNORE INTO request_dedup/);
  assert.deepEqual(bound, [
    'u@x.com:k9',                 // 命名空間化 PK
    'u@x.com',
    'POST /review/answer',
    200,
    JSON.stringify({ correct: true }),
    1_700_000_000_000,
  ]);
});
