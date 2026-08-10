import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackupFiles, highlightQuestionId, type BackupRows } from './backupLayout.ts';

const META = { email: 'me@example.com', generated_at: 1_754_000_000_000, schema_version: 1 };

function rows(over: Partial<BackupRows> = {}): BackupRows {
  return {
    questions: [],
    attempts: [],
    confidence: [],
    notes: [],
    highlights: [],
    progress: [],
    bookmarks: [],
    exams: [],
    examAnswers: [],
    lectureAnnotations: [],
    lectureNotes: [],
    freeNotes: [],
    ...over,
  };
}

const Q = {
  id: '113-050',
  year: 113,
  number: 50,
  group: '內科',
  stem: '孟買血型',
  options_json: '[{"key":"A","text":"a"}]',
  answer: 'A',
  explanation_json: '{"type":"doc","content":[]}',
  explanation_version: 3,
  explanation_updated_by: 'someone@example.com',
  explanation_updated_at: 1,
};

test('一題的所有紀錄併在同一個檔案裡', () => {
  const files = buildBackupFiles(
    META,
    rows({
      questions: [Q],
      attempts: [{ question_id: '113-050', chosen: 'A', is_correct: 1 }],
      confidence: [{ question_id: '113-050', confidence: 3, at: 5 }],
      notes: [{ question_id: '113-050', slot: 0, content_json: '{"type":"doc"}' }],
      progress: [{ question_id: '113-050', times_seen: 2 }],
      bookmarks: [{ question_id: '113-050', folder_name: '收藏' }],
      highlights: [{ store_key: 'anno:113-050', doc_json: '{"a":1}' }],
    })
  );

  const f = JSON.parse(files['questions/113/113-050.json']);
  assert.equal(f.question.stem, '孟買血型');
  assert.deepEqual(f.question.options, [{ key: 'A', text: 'a' }], 'options_json 應該被 parse');
  assert.equal(f.explanation.version, 3);
  assert.equal(f.my.attempts.length, 1);
  assert.equal(f.my.confidence.length, 1);
  assert.equal(f.my.notes.length, 1);
  assert.deepEqual(f.my.notes[0].content, { type: 'doc' });
  assert.equal(f.my.progress.times_seen, 2);
  assert.equal(f.my.bookmark.folder_name, '收藏');
  assert.equal(f.my.highlights.length, 1);
});

test('別題的紀錄不會混進來', () => {
  const files = buildBackupFiles(
    META,
    rows({
      questions: [Q, { ...Q, id: '113-051', number: 51 }],
      attempts: [
        { question_id: '113-050', chosen: 'A' },
        { question_id: '113-051', chosen: 'B' },
      ],
    })
  );
  assert.equal(JSON.parse(files['questions/113/113-050.json']).my.attempts.length, 1);
  assert.equal(JSON.parse(files['questions/113/113-051.json']).my.attempts[0].chosen, 'B');
});

test('沒有共筆詳解時 explanation 是 null,不是空物件', () => {
  const files = buildBackupFiles(
    META,
    rows({ questions: [{ ...Q, explanation_json: null }] })
  );
  assert.equal(JSON.parse(files['questions/113/113-050.json']).explanation, null);
});

test('壞掉的 JSON 原字串交出去,不讓整份備份炸掉', () => {
  const files = buildBackupFiles(
    META,
    rows({ questions: [{ ...Q, options_json: '{not json' }] })
  );
  assert.equal(JSON.parse(files['questions/113/113-050.json']).question.options, '{not json');
});

test('依年份分目錄', () => {
  const files = buildBackupFiles(
    META,
    rows({ questions: [Q, { ...Q, id: '114-001', year: 114, number: 1 }] })
  );
  assert.ok(files['questions/113/113-050.json']);
  assert.ok(files['questions/114/114-001.json']);
});

test('畫記依 store_key 前綴分流', () => {
  assert.equal(highlightQuestionId('anno:113-050'), '113-050');
  assert.equal(highlightQuestionId('anno:note:113-050'), '113-050');
  assert.equal(highlightQuestionId('anno:note:113-050:1'), '113-050');
  // 自由筆記的畫記不屬於任何題目。
  assert.equal(highlightQuestionId('anno:free:abc-123'), null);
  assert.equal(highlightQuestionId('whatever'), null);
});

test('自由筆記的畫記跟著那則筆記走', () => {
  const files = buildBackupFiles(
    META,
    rows({
      freeNotes: [{ id: 'n1', title: 'x', content_json: '{"type":"doc"}' }],
      highlights: [{ store_key: 'anno:free:n1', doc_json: '{"b":2}' }],
    })
  );
  const n = JSON.parse(files['notes/n1.json']);
  assert.equal(n.highlights.length, 1);
  // 而且不該同時被收進 misc(那會變成同一筆資料出現兩次)。
  assert.equal(files['misc/highlights.json'], undefined);
});

test('認不出前綴的畫記不會被丟掉', () => {
  const files = buildBackupFiles(
    META,
    rows({ highlights: [{ store_key: 'anno:mystery:1', doc_json: '{}' }] })
  );
  assert.equal(JSON.parse(files['misc/highlights.json']).length, 1);
});

test('全真模擬:一場一個檔案,答案嵌在裡面', () => {
  const files = buildBackupFiles(
    META,
    rows({
      exams: [{ id: 's1', year: 113, score: 80 }],
      examAnswers: [
        { session_id: 's1', question_id: '113-001', chosen: 'A' },
        { session_id: 's2', question_id: '113-002', chosen: 'B' },
      ],
    })
  );
  const e = JSON.parse(files['exams/s1.json']);
  assert.equal(e.session.score, 80);
  assert.equal(e.answers.length, 1, '別場的答案不該混進來');
});

test('講義:標題 + 頁數,畫記與筆記合在同一個檔案', () => {
  const files = buildBackupFiles(
    META,
    rows({
      lectureAnnotations: [
        { id: 'a1', slug: 'lec-1', lecture_title: '貧血概論', page: 3, kind: 'highlight', payload_json: '{}' },
      ],
      lectureNotes: [
        { id: 'n1', slug: 'lec-1', lecture_title: '貧血概論', page: 7, content_json: '{"type":"doc"}' },
      ],
    })
  );
  const l = JSON.parse(files['lectures/lec-1.json']);
  assert.equal(l.title, '貧血概論');
  assert.equal(l.annotations[0].page, 3);
  assert.equal(l.notes[0].page, 7);
});

test('只有畫記、沒有筆記的講義也要有檔案', () => {
  const files = buildBackupFiles(
    META,
    rows({
      lectureAnnotations: [{ id: 'a1', slug: 'lec-2', lecture_title: 'T', page: 1, payload_json: '{}' }],
    })
  );
  assert.ok(files['lectures/lec-2.json']);
});

test('manifest 與 CLAUDE.md 一定在', () => {
  const files = buildBackupFiles(META, rows({ questions: [Q] }));
  const m = JSON.parse(files['manifest.json']);
  assert.equal(m.email, 'me@example.com');
  assert.equal(m.schema_version, 1);
  assert.equal(m.counts.questions, 1);
  // CLAUDE.md 要說清楚這是誰的、以及不含別人的東西 —— 那是這份 zip 唯一
  // 會被人直接讀的檔案。
  assert.match(files['CLAUDE.md'], /只有這個帳號自己的紀錄/);
  assert.match(files['CLAUDE.md'], /TipTap/);
});
