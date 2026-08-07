import test from 'node:test';
import assert from 'node:assert/strict';

// noteHighlights 讀 localStorage(這台裝置的畫記)並與伺服器那份取聯集。
// node 沒有 localStorage,所以在載入模組**之前**先塞一個最小替身 —— 之後
// 的 import 才不會在模組初始化時就炸。
class FakeStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}
const store = new FakeStorage();
(globalThis as any).localStorage = store;

const { mergeFreeNoteHighlights, mergeNoteHighlights } = await import('./noteHighlights.ts');

// 一段有畫記的段落:被標記的文字節點帶 highlight mark。
function doc(text: string, hlFrom: number, hlTo: number) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: text.slice(0, hlFrom) },
          { type: 'text', text: text.slice(hlFrom, hlTo), marks: [{ type: 'highlight' }] },
          { type: 'text', text: text.slice(hlTo) },
        ].filter((n) => n.text),
      },
    ],
  };
}

const row = (key: string, d: unknown) => ({ store_key: key, doc_json: JSON.stringify(d) });

test('自由筆記畫記依 note id 分組,標題由呼叫端補上', () => {
  store.clear();
  const groups = mergeFreeNoteHighlights(
    [row('anno:free:n1:h1', doc('hepcidin 由肝臟分泌,發炎時上升', 0, 8))],
    new Map([['n1', '鐵代謝速記']]),
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'n1');
  assert.equal(groups[0].title, '鐵代謝速記');
  assert.deepEqual(
    groups[0].lines[0].segments.filter((s) => s.hl).map((s) => s.text),
    ['hepcidin'],
  );
});

test('同一則筆記的多個 store_key(不同段落)併成一組', () => {
  store.clear();
  const groups = mergeFreeNoteHighlights(
    [
      row('anno:free:n1:h1', doc('AML 的誘導治療', 0, 3)),
      row('anno:free:n1:h2', doc('CML 用 TKI', 0, 3)),
    ],
    new Map([['n1', 'x']]),
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].total, 2);
});

test('標題查不到就整組略過 —— 筆記已被刪,卡片會連不到任何地方', () => {
  store.clear();
  const groups = mergeFreeNoteHighlights(
    [row('anno:free:gone:h1', doc('殘留的畫記', 0, 2))],
    new Map(),
  );
  assert.deepEqual(groups, []);
});

test('未命名筆記顯示佔位字串,而不是空白卡片', () => {
  store.clear();
  const groups = mergeFreeNoteHighlights(
    [row('anno:free:n1:h1', doc('內容', 0, 1))],
    new Map([['n1', '']]),
  );
  assert.equal(groups[0].title, '(未命名筆記)');
});

test('兩種前綴互不汙染:題目畫記不會被當成自由筆記,反之亦然', () => {
  store.clear();
  const qRow = row('anno:note:114-001:h1', doc('題目筆記的畫記', 0, 2));
  const fRow = row('anno:free:n1:h1', doc('自由筆記的畫記', 0, 2));

  assert.deepEqual(mergeFreeNoteHighlights([qRow], new Map([['n1', 'x']])), []);

  const qGroups = mergeNoteHighlights([fRow]);
  assert.deepEqual(qGroups, []);

  const qOnly = mergeNoteHighlights([qRow]);
  assert.equal(qOnly.length, 1);
  assert.equal(qOnly[0].qid, '114-001');
});

test('localStorage 與伺服器同一個 key 時,伺服器那份勝出', () => {
  store.clear();
  store.setItem(
    'anno:free:n1:h1',
    JSON.stringify({ h: 'h1', doc: doc('舊的本機內容', 0, 1), t: 1 }),
  );
  const groups = mergeFreeNoteHighlights(
    [row('anno:free:n1:h1', doc('新的伺服器內容', 0, 1))],
    new Map([['n1', 'x']]),
  );
  assert.equal(groups[0].total, 1);
  const text = groups[0].lines[0].segments.map((s) => s.text).join('');
  assert.match(text, /伺服器/);
});
