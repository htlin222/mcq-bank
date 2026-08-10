// 捲動方向 → 收起/放回 的判定。
//
// 這一段刻意做成純函式:真正難的不是「往下捲就藏起來」,而是**哪些捲動不算方向意圖**
// —— iOS 橡皮筋在兩端會給出超出範圍的 scrollY、慣性捲動會連續丟事件、手指微抖會
// 產生正負交錯的 delta。這些在瀏覽器裡很難穩定重現(調時序會得到假綠燈,見 CLAUDE.md
// 「作答紀錄被閒置預抓蓋掉」那節的教訓),所以邊界條件全部在這裡驗。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_CHROME,
  nextChromeState,
  seedChrome,
  CHROME_THRESHOLD,
  type ScrollSample,
} from './autoHideChrome.ts';

/** 預設樣本:已經捲過「一律顯示」的區間,沒有強制顯示,沒有過捲。 */
function sample(y: number, over: Partial<ScrollSample> = {}): ScrollSample {
  return { y, maxY: 5000, revealAbove: 64, forceShow: false, ...over };
}

/**
 * 連續餵入一串 scrollY,回傳最終狀態。第一個值是**起算點**,不是一次捲動 ——
 * 掛載時就是這樣(見 seedChrome)。
 */
function feed(ys: number[], over: Partial<ScrollSample> = {}) {
  let s = seedChrome(ys[0]);
  for (const y of ys.slice(1)) s = nextChromeState(s, sample(y, over));
  return s;
}

test('往下捲超過閾值就收起', () => {
  const s = feed([100, 100 + CHROME_THRESHOLD]);
  assert.equal(s.hidden, true);
});

test('往下捲但還沒到閾值,維持顯示', () => {
  const s = feed([100, 100 + CHROME_THRESHOLD - 1]);
  assert.equal(s.hidden, false);
});

test('往回捲超過閾值就放回來', () => {
  let s = feed([100, 300]);
  assert.equal(s.hidden, true, '前置條件:先收起來');
  s = nextChromeState(s, sample(300 - CHROME_THRESHOLD));
  assert.equal(s.hidden, false);
});

test('換方向時累積要歸零 —— 否則要先「還掉」前一個方向的量才有反應', () => {
  // 先往下捲很長一段(累積 +400),再往回捲剛好一個閾值。
  // 若累積不歸零,得往回捲 400+ 才會放回來 —— 那就是「怎麼拉都拉不回來」。
  let s = feed([100, 500]);
  assert.equal(s.hidden, true);
  s = nextChromeState(s, sample(500 - CHROME_THRESHOLD));
  assert.equal(s.hidden, false, '往回捲一個閾值就該放回來,不管往下捲了多遠');
});

test('手指微抖(正負交錯且都不到閾值)不會閃', () => {
  const jitter = [200, 203, 200, 204, 201, 203];
  const s = feed(jitter);
  assert.equal(s.hidden, false, '每一段都不到閾值,狀態不該改變');
});

test('捲到頂端附近一律顯示,而且累積要清掉', () => {
  let s = feed([100, 400]);
  assert.equal(s.hidden, true);
  s = nextChromeState(s, sample(30)); // < revealAbove
  assert.equal(s.hidden, false);
  assert.equal(s.acc, 0, '累積沒清掉的話,離開頂端第一下就會被舊的量帶著跑');
});

test('revealAbove 的邊界是「小於等於」—— 剛好在線上時顯示', () => {
  let s = feed([100, 400]);
  s = nextChromeState(s, sample(64, { revealAbove: 64 }));
  assert.equal(s.hidden, false);
});

test('forceShow 蓋過一切(輸入框聚焦、reduced-motion)', () => {
  let s = feed([100, 400]);
  assert.equal(s.hidden, true);
  s = nextChromeState(s, sample(500, { forceShow: true }));
  assert.equal(s.hidden, false);
});

// ── 橡皮筋 ──────────────────────────────────────────────────
//
// iOS 在兩端會回報超出範圍的 scrollY。那不是使用者在「往某個方向捲」,是回彈動畫。
// 不濾掉的話:頂端往下拉放手,回彈的過程是 scrollY 遞增 → 被判定成「往下捲」→ 一鬆手
// 就把兩條列收起來,而使用者明明在往上拉。

test('頂端過捲(scrollY < 0)一律顯示 —— 由 revealAbove 涵蓋', () => {
  // 頂端的橡皮筋只可能發生在 scrollY ≈ 0,而那時本來就在 revealAbove 之內。
  // 這條釘住的是「不需要另外一條 y < 0 的規則」——多一條就多一個要維護的分支。
  let s = feed([100, 400]);
  assert.equal(s.hidden, true);
  s = nextChromeState(s, sample(-30));
  assert.equal(s.hidden, false);
  assert.equal(s.acc, 0, '回到頂端要清掉累積');
});

test('頂端回彈的整段位移不會被讀成「往下捲」', () => {
  // -50 → -20 → 0:每一格 delta 都是正的,但全都在 revealAbove 之內。
  let s = seedChrome(0);
  for (const y of [-50, -20, 0]) s = nextChromeState(s, sample(y));
  assert.equal(s.hidden, false, '放手回彈不該把兩條列收起來');
});

test('底端撞到底再彈回來,維持收起 —— 那不是「往回捲」', () => {
  // iOS 捲到底繼續拉:scrollY 會超過 maxY 再彈回。彈回那一段 delta 是負的,
  // 不擋的話兩條列會在使用者只是撞到底的時候冒出來。
  let s = feed([100, 4900, 5000], { maxY: 5000 });
  assert.equal(s.hidden, true, '前置條件:一路往下捲已經收起來');
  for (const y of [5080, 5040, 5000]) {
    s = nextChromeState(s, sample(y, { maxY: 5000 }));
  }
  assert.equal(s.hidden, true);
});

test('真的往回捲時,即使在頁尾也要放回來', () => {
  // 上一條的對照組:同樣在底部,但這次是範圍內的往回捲,必須有反應。
  // 少了它,上一條可以靠「永遠不放回來」通過。
  let s = feed([100, 4900, 5000], { maxY: 5000 });
  assert.equal(s.hidden, true);
  s = nextChromeState(s, sample(5000 - CHROME_THRESHOLD, { maxY: 5000 }));
  assert.equal(s.hidden, false);
});

test('delta 為 0 的事件(慣性停下)不改變任何東西', () => {
  let s = feed([100, 400]);
  const before = { ...s };
  s = nextChromeState(s, sample(400));
  assert.deepEqual(s, before);
});

test('初始狀態是顯示', () => {
  assert.equal(INITIAL_CHROME.hidden, false);
});
