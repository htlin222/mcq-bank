// 題幹否定詞的切分(#149)。
//
// 這一層的價值來自**稀有** —— 詞表一長就沒有作用了,所以測試除了「有標到」也要
// 守住「不該標的沒被標到」。

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitNegations } from "./stemHighlight.ts";

/** 只取被標起來的片段,方便斷言。 */
const hits = (s: string) => splitNegations(s).filter((p) => p.hit).map((p) => p.text);
/** 串回去要跟原字串一模一樣 —— 少一個字就是把題幹弄丟了。 */
const roundtrip = (s: string) => splitNegations(s).map((p) => p.text).join("");

test("回報的那一題", () => {
  const s = "Which one is incorrect for the management of multicentric Castleman disease (MCD)?";
  assert.deepEqual(hits(s), ["incorrect"]);
  assert.equal(roundtrip(s), s);
});

test("wrong / except / false / not true", () => {
  assert.deepEqual(hits("Which statement is wrong about MPNs?"), ["wrong"]);
  assert.deepEqual(hits("All of the following are true EXCEPT:"), ["EXCEPT"]);
  assert.deepEqual(hits("Which of the following is false?"), ["false"]);
  assert.deepEqual(hits("Which one is not true?"), ["not true"]);
});

test("中文的否定問句", () => {
  assert.deepEqual(hits("下列敘述何者錯誤?"), ["錯誤"]);
  assert.deepEqual(hits("下列何者不正確?"), ["不正確"]);
  assert.deepEqual(hits("下列敘述何者為非?"), ["為非"]);
});

test("大小寫都要抓 —— 官方題幹常把 EXCEPT 全大寫", () => {
  assert.deepEqual(hits("... is INCORRECT?"), ["INCORRECT"]);
  assert.deepEqual(hits("... is Wrong?"), ["Wrong"]);
});

test("`not true` 中間多個空白也算", () => {
  assert.deepEqual(hits("which is not  true?"), ["not  true"]);
});

// ── 不該標的 ────────────────────────────────────────────────
//
// 這幾條是這個功能會不會變成雜訊的關鍵。少了它們,把詞表加寬到 `not`、`非`
// 也一樣全綠,而畫面上會滿頁通紅。

test("拉丁字要卡字界", () => {
  assert.deepEqual(hits("The dose was wrongly calculated."), []);
  assert.deepEqual(hits("with the exception of CML"), []);
});

test("單獨的「非」不算 —— 非何杰金氏淋巴瘤幾乎每頁都有", () => {
  assert.deepEqual(hits("非何杰金氏淋巴瘤的分期"), []);
  assert.deepEqual(hits("非典型慢性骨髓性白血病"), []);
});

test("單獨的 not 不算 —— 那是選項的日常用語", () => {
  assert.deepEqual(hits("JAK2 is not associated with this finding."), []);
});

test("「正確」不會因為含在「不正確」裡就被標到", () => {
  assert.deepEqual(hits("下列敘述何者正確?"), []);
});

// ── 結構 ────────────────────────────────────────────────────

test("同一句有兩個也都要標", () => {
  const s = "Which is wrong and which is incorrect?";
  assert.deepEqual(hits(s), ["wrong", "incorrect"]);
  assert.equal(roundtrip(s), s);
});

test("沒有命中時回一整段,不是空陣列", () => {
  const s = "下列敘述何者正確?";
  assert.deepEqual(splitNegations(s), [{ text: s, hit: false }]);
});

test("空字串回空陣列", () => {
  assert.deepEqual(splitNegations(""), []);
});

test("連續呼叫的結果一樣 —— g 旗標的 lastIndex 不能留在正則物件上", () => {
  // 這是實際會踩的坑:共用同一個 RegExp 實例時,第二次呼叫會從上次結束的位置
  // 開始找,於是同一段文字第二次就標不到了。
  const s = "Which statement is wrong?";
  assert.deepEqual(hits(s), ["wrong"]);
  assert.deepEqual(hits(s), ["wrong"]);
  assert.deepEqual(hits(s), ["wrong"]);
});

test("標點與換行原樣保留", () => {
  const s = "第一行\n下列何者錯誤?\n(A) 甲";
  assert.equal(roundtrip(s), s);
  assert.deepEqual(hits(s), ["錯誤"]);
});
