import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickActiveSection, type SectionTop } from './tocSpy.ts';

const LINE = 88;

function at(...tops: number[]): SectionTop[] {
  const ids = ['basic', 'telegram', 'ai', 'mcq', 'account'];
  return tops.map((top, i) => ({ id: ids[i], top }));
}

test('頁面最頂 —— 所有區塊都在判定線之下,選第一區', () => {
  assert.equal(
    pickActiveSection({ sections: at(80, 642, 873, 1512, 2311), line: LINE, atBottom: false }),
    'basic',
  );
});

test('完全捲在第一區之上時仍選第一區', () => {
  assert.equal(
    pickActiveSection({ sections: at(200, 762, 993, 1632, 2431), line: LINE, atBottom: false }),
    'basic',
  );
});

test('選最後一個已越過判定線的區塊', () => {
  // ai 剛好卡在線上(80 <= 88),mcq/account 還在下面
  assert.equal(
    pickActiveSection({ sections: at(-713, -151, 80, 719, 1518), line: LINE, atBottom: false }),
    'ai',
  );
});

test('剛好等於判定線算越過', () => {
  assert.equal(
    pickActiveSection({ sections: at(-100, 88, 900, 1600, 2400), line: LINE, atBottom: false }),
    'telegram',
  );
});

test('差一像素沒越過就不算', () => {
  assert.equal(
    pickActiveSection({ sections: at(-100, 89, 900, 1600, 2400), line: LINE, atBottom: false }),
    'basic',
  );
});

// 這條是不用 IntersectionObserver 的理由:AI 助手展開提示詞編輯器後可能比整個
// 視窗還高,那時它不與任何窄觀察帶相交,用相交判定會讓高亮憑空消失。
test('比視窗還高的區塊,整段捲動期間都保持高亮', () => {
  for (const top of [0, -300, -1200, -3000]) {
    assert.equal(
      pickActiveSection({ sections: at(-4000, -3500, top, 2000, 2800), line: LINE, atBottom: false }),
      'ai',
      `top=${top} 時應仍高亮 ai`,
    );
  }
});

// 最後一張卡片若比剩餘視窗矮,它的頂部永遠越不過判定線 —— 不特判就永遠選不到。
test('捲到底一律選最後一區,即使它的頂部沒越過判定線', () => {
  assert.equal(
    pickActiveSection({ sections: at(-2000, -1500, -900, -400, 300), line: LINE, atBottom: true }),
    'account',
  );
});

test('捲到底優先於一般判定', () => {
  assert.equal(
    pickActiveSection({ sections: at(-2000, -1500, -900, -400, -100), line: LINE, atBottom: true }),
    'account',
  );
});

test('不假設傳入順序就是版面順序', () => {
  const shuffled: SectionTop[] = [
    { id: 'mcq', top: 719 },
    { id: 'basic', top: -713 },
    { id: 'account', top: 1518 },
    { id: 'ai', top: 80 },
    { id: 'telegram', top: -151 },
  ];
  assert.equal(pickActiveSection({ sections: shuffled, line: LINE, atBottom: false }), 'ai');
});

test('沒有區塊時回 null,不丟例外', () => {
  assert.equal(pickActiveSection({ sections: [], line: LINE, atBottom: false }), null);
  assert.equal(pickActiveSection({ sections: [], line: LINE, atBottom: true }), null);
});

test('只有一個區塊時永遠選它', () => {
  assert.equal(
    pickActiveSection({ sections: [{ id: 'only', top: 5000 }], line: LINE, atBottom: false }),
    'only',
  );
});
