// `getActiveChallenges()` 的兩件事:往返次數,以及迴圈裡的順序語意。
//
// 這支跑在真的 SQLite 上(worker/lib/test-d1.ts),不是手寫 stub —— 理由寫在
// 那個檔案的開頭。`challenges.test.ts` 驗的是純函式 `decide()`,兩者不重疊。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestDb } from './test-d1.ts';
import { getActiveChallenges } from './challenges.ts';
import { FAST_RULE_AGREES } from './challenges-state.ts';

const NOW = 1_754_000_000_000;
const ME = 'me@example.com';

function seed(db: any) {
  const t = NOW - 60_000;
  for (const [email, name] of [
    [ME, '我'],
    ['proposer-a@example.com', '提案甲'],
    ['proposer-b@example.com', '提案乙'],
    ['v1@example.com', '投票一'],
    ['v2@example.com', '投票二'],
  ]) {
    db.exec(
      `INSERT INTO users (email, display_name, created_at, updated_at)
       VALUES ('${email}', '${name}', ${t}, ${t})`
    );
  }
  db.exec(
    `INSERT INTO questions (id, year, number, stem, options_json, answer, created_at)
     VALUES ('113-050', 113, 50, 'stem', '[{"key":"A","text":"a"},{"key":"B","text":"b"}]', 'A', ${t})`
  );
}

function addChallenge(
  db: any,
  id: string,
  proposer: string,
  letter: string,
  createdAt = NOW - 60_000
) {
  db.exec(
    `INSERT INTO answer_challenges
       (id, question_id, proposer_email, proposed_answer,
        original_answer_at_challenge, rationale_json, status, created_at)
     VALUES ('${id}', '113-050', '${proposer}', '${letter}', 'A',
             '{"type":"doc","content":[]}', 'open', ${createdAt})`
  );
}

function addVote(db: any, challengeId: string, voter: string, vote: string) {
  db.exec(
    `INSERT INTO challenge_votes (challenge_id, voter_email, vote, created_at, updated_at)
     VALUES ('${challengeId}', '${voter}', '${vote}', ${NOW - 30_000}, ${NOW - 30_000})`
  );
}

// ──────────────────────────────────────────────────────────────
// 往返次數
// ──────────────────────────────────────────────────────────────

test('一個進行中的挑戰:整趟只發一次查詢', async () => {
  const db = makeTestDb();
  seed(db);
  addChallenge(db, 'ch1', 'proposer-a@example.com', 'B');
  addVote(db, 'ch1', 'v1@example.com', 'agree');
  addVote(db, 'ch1', ME, 'disagree');
  // 已經是 contested,而且 1 agree / 1 disagree 落在 promote 與 reject 的門檻之間
  // —— 這一輪 decide() 回 no-change,量到的才是「沒有轉移時的成本」。
  db.exec(`UPDATE answer_challenges SET status='contested', contested_at=${NOW - 40_000}
           WHERE id='ch1'`);

  db.queries.length = 0;
  const out = await getActiveChallenges(db, '113-050', ME, NOW);

  // 先確認真的有東西回來 —— 否則「查詢次數少」只是因為什麼都沒做。
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'ch1');
  assert.equal(out[0].agrees, 1);
  assert.equal(out[0].disagrees, 1);
  assert.equal(out[0].my_vote, 'disagree');
  assert.equal(out[0].proposer_name, '提案甲');

  // 舊版:清單 1 + 每個挑戰 6 次。現在票數/我的票/提案者名字都在同一支查詢裡,
  // 而 recompute 用呼叫端已經讀到的列與票數,所以沒有轉移時一次都不必再問。
  assert.equal(
    db.queries.length,
    1,
    `預期 1 次查詢,實際 ${db.queries.length}:\n${db.queries.join('\n')}`
  );
});

test('多帶的 join 欄位不會漏進 API 回應', async () => {
  const db = makeTestDb();
  seed(db);
  addChallenge(db, 'ch1', 'proposer-a@example.com', 'B');
  addVote(db, 'ch1', 'v1@example.com', 'disagree');

  const [row] = await getActiveChallenges(db, '113-050', ME, NOW);
  // last_vote_at 是給 decide() 用的查詢細節,不是對外欄位。
  assert.ok(!('last_vote_at' in row), Object.keys(row).join(','));
});

test('沒有進行中的挑戰:只問一次就回空陣列', async () => {
  const db = makeTestDb();
  seed(db);

  db.queries.length = 0;
  const out = await getActiveChallenges(db, '113-050', ME, NOW);
  assert.deepEqual(out, []);
  assert.equal(db.queries.length, 1);
});

// ──────────────────────────────────────────────────────────────
// 順序語意:promote 會讓同題的兄弟在同一次呼叫裡消失
// ──────────────────────────────────────────────────────────────

// ch1 先建立,所以 ORDER BY created_at ASC 會先處理它。ch2 自己一票都沒有,
// 單看它什麼都不會發生 —— 它會消失只可能是因為 ch1 的 promote 連帶 supersede。
function twoChallenges(agreesOnCh1: number) {
  const db = makeTestDb();
  seed(db);
  addChallenge(db, 'ch1', 'proposer-a@example.com', 'B', NOW - 120_000);
  const voters = ['v1@example.com', 'v2@example.com'];
  for (let i = 0; i < agreesOnCh1; i++) addVote(db, 'ch1', voters[i], 'agree');
  addChallenge(db, 'ch2', 'proposer-b@example.com', 'C', NOW - 60_000);
  return db;
}

test('對照組:ch1 還沒達到門檻時,兩個挑戰都在清單上', async () => {
  // 少了這一條,下一個測試的「ch2 不見了」可能只是它從頭就沒被撈出來。
  assert.equal(FAST_RULE_AGREES, 2, '門檻改了的話這組 fixture 要跟著調');
  const out = await getActiveChallenges(twoChallenges(1), '113-050', ME, NOW);
  assert.deepEqual(out.map((c) => c.id).sort(), ['ch1', 'ch2']);
});

test('一個挑戰達到 promote 門檻時,同題的另一個在同一次呼叫裡就消失', async () => {
  const db = twoChallenges(FAST_RULE_AGREES);

  const out = await getActiveChallenges(db, '113-050', ME, NOW);
  assert.deepEqual(out, [], `ch2 應該一起消失,實際回傳:${out.map((c) => c.id).join(',')}`);

  // 而且是真的落地了,不是只在回傳值上被過濾掉。
  const rows = db.query(
    `SELECT id, status FROM answer_challenges WHERE question_id = '113-050' ORDER BY id`
  );
  assert.deepEqual(rows, [
    { id: 'ch1', status: 'promoted' },
    { id: 'ch2', status: 'archived' },
  ]);
  const [q] = db.query<{ answer: string }>(`SELECT answer FROM questions WHERE id = '113-050'`);
  assert.equal(q.answer, 'B', '答案應該被翻成 ch1 提議的字母');
});

test('promote 之後,後面的挑戰不再吃呼叫端預載的舊列', async () => {
  const db = twoChallenges(FAST_RULE_AGREES);

  db.queries.length = 0;
  await getActiveChallenges(db, '113-050', ME, NOW);

  // ch2 那一輪必須回頭讀 DB(否則它會拿到 status='open' 的舊列,然後被當成
  // 還活著留在清單裡)。這裡認的是那一次 SELECT。
  const reread = db.queries.filter((q: string) =>
    q.startsWith('SELECT * FROM answer_challenges WHERE id = ?')
  );
  assert.equal(
    reread.length,
    1,
    `promote 之後應該剛好重讀一次兄弟的列,實際 ${reread.length} 次`
  );
});
