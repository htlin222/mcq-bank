# 抹片 × 筆試 操作一致性 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 讓抹片練習的入口導覽與筆試對稱（Layer 1），並在複習模式的提示鏈補上
「看選項」——打字答不出來時退回筆試那種選擇/送出互動（Layer 3）。範圍依
`docs/plans/2026-09-05-smear-exam-parity-design.md` 排序後的決定：本輪只做
Layer 1 + Layer 3，Layer 2（答後內容面板收斂）留給下一輪。

**Architecture:** Layer 1 新增一個路由 landing 頁（`SmearExam.tsx`），行為完全
複製 `SmearReview.tsx` 已經確立的模式（路由 → 點按鈕 → 開既有的
`StartDialog`），三個既有呼叫點（`App.tsx` 底部導覽、`Smear.tsx` 練習分頁、
`SmearDashboard.tsx`）改成導去這個新路由。Layer 3 新增一支唯讀的伺服器端點
（`POST /api/smear/sessions/:id/mc-options`，複習模式限定）配一支新的純函式
（`pickMcqDistractors`/`pickMcqOptions`），前端在 `AnswerInput.tsx` 加一顆
「看選項」按鈕把輸入框換成單選清單，送出仍走既有的 `/answer` 端點
（`hint_used: 'mc_choice'`，該欄位本來就是自由字串,不需要改 schema）。

**Tech Stack:** React + TypeScript（frontend）、Hono + D1（worker）、
`node --test`（純函式單元測試）、Playwright（`frontend/e2e/*.test.mjs`）。

---

## 前置確認

這份計畫在 `.worktrees/smear-exam-parity`（分支 `feat/smear-exam-parity`）裡
撰寫與執行。開始任何任務前先確認在正確的目錄:

```bash
cd /Users/htlin/hema-2026/.worktrees/smear-exam-parity
git branch --show-current   # 應該印出 feat/smear-exam-parity
```

---

# Phase 1 — Layer 1：入口對稱

## Task 1：新增 `SmearExam.tsx` 落地頁

**Files:**
- Create: `frontend/src/routes/SmearExam.tsx`

**Step 1：寫檔案**

結構完全比照 `frontend/src/routes/SmearReview.tsx`（同一個 `max-w-2xl` 容器、
同一顆「回抹片練習」`<Link>`、同一種 `font-serif` 標題），但不需要主題卡片
（全真模式不篩主題，理由見設計文件），只有一段說明 + 一顆按鈕開既有的
`StartDialog`：

```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Timer } from "lucide-react";
import { StartDialog } from "../components/smear/StartDialog";

// /smear/exam —— 全真模式的獨立落地頁。跟 /smear/review 是同一套心智模型
// (路由 landing → 點按鈕開既有的 StartDialog),只是這裡沒有主題卡片 ——
// 全真模式照題庫實際比例抽樣、模擬真考卷,主題式挑選跟它的用途矛盾(見
// CLAUDE.md「抹片練習」設計:分層抽樣、PO 不進全真)。這一頁存在的理由
// 純粹是入口對稱:底部導覽/首頁抹片卡/練習分頁的「全真」都導來這裡,
// 跟「複習」一樣有一個可以分享、可以加書籤的網址,而不是直接彈一個
// 沒有網址的對話框(見 docs/plans/2026-09-05-smear-exam-parity-design.md
// 的 Layer 1)。
export function SmearExam() {
	const [dialogOpen, setDialogOpen] = useState(false);

	return (
		<div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 pb-20">
			<Link
				to="/smear"
				className="text-sm text-ink-500 dark:text-ink-400 hover:text-accent inline-flex items-center gap-1 mb-4"
			>
				<ArrowLeft size={14} /> 回抹片練習
			</Link>

			<h1 className="font-serif text-2xl text-ink-900 dark:text-ink-100 mb-1">
				全真模式
			</h1>
			<p className="text-ink-500 dark:text-ink-400 text-sm mb-6">
				連續作答,全程不揭曉正解;交卷後才看整體成績與逐題檢討 ——
				適合考前自我測驗,照題庫實際比例抽樣,不能挑主題。
			</p>

			<button
				type="button"
				onClick={() => setDialogOpen(true)}
				className="w-full text-left bg-white dark:bg-ink-800 border border-ink-200 dark:border-ink-700 rounded-lg p-4 shadow-paper hover:shadow-md hover:border-accent transition"
			>
				<div className="flex items-center gap-2">
					<Timer size={16} className="text-accent" aria-hidden="true" />
					<span className="font-medium text-ink-900 dark:text-ink-100">
						開始全真模式
					</span>
				</div>
				<p className="text-xs text-ink-500 dark:text-ink-400 mt-1">
					可調整題數與作答寫法
				</p>
			</button>

			{dialogOpen && (
				<StartDialog
					initialMode="exam"
					onClose={() => setDialogOpen(false)}
				/>
			)}
		</div>
	);
}
```

**Step 2：確認型別檢查過**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 沒有跟 `SmearExam.tsx` 相關的錯誤（這一步還沒接到路由表，不會有
「unused export」以外的錢，這個新檔案本身不會被 unused 警告，因為 tsc 預設
不對未被 import 的 export 報錯）。

---

## Task 2：註冊路由 + 修底部導覽（`App.tsx`）

**Files:**
- Modify: `frontend/src/App.tsx`

**Step 1：加 import**

在現有 `import { SmearReview } from "./routes/SmearReview";`（或鄰近的 smear
路由 import 群組）旁邊加一行：

```tsx
import { SmearExam } from "./routes/SmearExam";
```

**Step 2：註冊路由**

找到（約第 315-322 行）：

```tsx
<Route path="/smear" element={<Smear />} />
{/* 複習模式的獨立主題選擇頁 —— 必須排在 /smear/dx/:id、/smear/s/:id
    之前沒有影響(路徑第二段是固定字面值 "review",不會跟
    ":id" 這種萬用參數衝突),但仍照慣例把具體路徑排在前面。 */}
<Route path="/smear/review" element={<SmearReview />} />
<Route path="/smear/dx/:id" element={<SmearDx />} />
```

改成：

```tsx
<Route path="/smear" element={<Smear />} />
{/* 複習/全真的獨立落地頁 —— 都必須排在 /smear/dx/:id、/smear/s/:id
    之前沒有影響(路徑第二段是固定字面值,不會跟 ":id" 這種萬用參數
    衝突),但仍照慣例把具體路徑排在前面。 */}
<Route path="/smear/review" element={<SmearReview />} />
<Route path="/smear/exam" element={<SmearExam />} />
<Route path="/smear/dx/:id" element={<SmearDx />} />
```

**Step 3：底部導覽改用 `BottomItem`，拿掉 `BottomAction`**

找到（約第 350-394 行）：

```tsx
<BottomItem to="/smear/review" Icon={BookOpen} label="複習" />
<BottomAction
	onClick={() => setSmearExamDialogOpen(true)}
	Icon={PenLine}
	label="全真"
/>
```

改成：

```tsx
<BottomItem to="/smear/review" Icon={BookOpen} label="複習" />
<BottomItem to="/smear/exam" Icon={PenLine} label="全真" />
```

同一個函式再往下找到：

```tsx
{smearExamDialogOpen && (
	<StartDialog
		initialMode="exam"
		onClose={() => setSmearExamDialogOpen(false)}
	/>
)}
```

整段刪除（邏輯已經搬進 `SmearExam.tsx` 自己管）。

**Step 4：清掉不再用的 state / import**

刪除（約第 88 行）：

```tsx
const [smearExamDialogOpen, setSmearExamDialogOpen] = useState(false);
```

刪除頂端的：

```tsx
import { StartDialog } from "./components/smear/StartDialog";
```

（先用 grep 確認 `App.tsx` 裡沒有其他地方還在用 `StartDialog` 再刪：
`grep -n "StartDialog" frontend/src/App.tsx` 應該只剩剛才要刪的那兩處。）

**Step 5：刪除整個 `BottomAction` 函式**

找到並整段刪除（約第 534-557 行，含它上面的檔頭註解——那段註解描述的正是
現在要拿掉的特例）：

```tsx
// 底部導覽裡不對應任何頁面、只是開一個對話框的動作鈕(目前只有抹片全真
// 模式)——刻意不用 NavLink:...
function BottomAction({
	onClick,
	Icon,
	label,
}: {
	onClick: () => void;
	Icon: LucideIcon;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex flex-col items-center justify-center h-14 text-[11px] gap-0.5 text-ink-500 dark:text-ink-400"
		>
			<Icon size={20} />
			<span>{label}</span>
		</button>
	);
}
```

**Step 6：型別檢查 + 確認沒有殘留引用**

```bash
grep -n "BottomAction\|smearExamDialogOpen" frontend/src/App.tsx
```

Expected: 沒有任何輸出。

```bash
cd frontend && npx tsc --noEmit
```

Expected: 無錯誤。

---

## Task 3：修 `SmearDashboard.tsx` 的全真卡片

**Files:**
- Modify: `frontend/src/components/smear/SmearDashboard.tsx`

**Step 1：拿掉 `examDialogOpen` state 與 import**

刪除（約第 13 行）：

```tsx
import { StartDialog } from "./StartDialog";
```

刪除（約第 36-38 行，含檔頭那段現在過期的說明）：

```tsx
// 「複習模式」導去 /smear/review 的主題式選擇頁,不再直接開對話框
// (見 SmearReview.tsx 檔頭的設計理由)。全真模式沒有對應頁面,維持
// 原地開對話框。
const [examDialogOpen, setExamDialogOpen] = useState(false);
```

**Step 2：改 ModeCard 的 onClick**

找到：

```tsx
<ModeCard
	icon={<Timer size={18} aria-hidden="true" />}
	title="全真模式"
	desc="連續作答,全程不揭曉正解;交卷後才看整體成績與逐題檢討 —— 適合考前自我測驗。"
	onClick={() => setExamDialogOpen(true)}
/>
</section>
{examDialogOpen && (
	<StartDialog initialMode="exam" onClose={() => setExamDialogOpen(false)} />
)}
```

改成：

```tsx
<ModeCard
	icon={<Timer size={18} aria-hidden="true" />}
	title="全真模式"
	desc="連續作答,全程不揭曉正解;交卷後才看整體成績與逐題檢討 —— 適合考前自我測驗。"
	onClick={() => navigate("/smear/exam")}
/>
</section>
```

（`navigate` 這個元件裡已經有,`useNavigate()` 在檔案開頭已宣告,不需要新增。）

**Step 3：確認 `useState` import 沒有變成完全沒用**

`grep -n "useState" frontend/src/components/smear/SmearDashboard.tsx` ——
`sessions`/`wrong` 兩個 state 還在用,`useState` import 保留不動。

**Step 4：型別檢查**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 無錯誤。

---

## Task 4：修 `Smear.tsx` 練習分頁的全真卡片

**Files:**
- Modify: `frontend/src/routes/Smear.tsx`

**Step 1：拿掉 `PracticeTab` 裡的 `examDialogOpen` state**

找到（約第 150-154 行）：

```tsx
function PracticeTab({ onGotoWrong }: { onGotoWrong: () => void }) {
	const navigate = useNavigate();
	// 「複習模式」不再直接開對話框 —— 導去 /smear/review 的主題式選擇頁
	// (見該檔頭的設計理由)。全真模式沒有對應頁面,維持原地開對話框。
	const [examDialogOpen, setExamDialogOpen] = useState(false);
```

改成：

```tsx
function PracticeTab({ onGotoWrong }: { onGotoWrong: () => void }) {
	const navigate = useNavigate();
```

**Step 2：改 ModeCard 的 onClick，拿掉對話框**

找到（約第 197-208 行）：

```tsx
<ModeCard
	icon={<Timer size={18} aria-hidden="true" />}
	title="全真模式"
	desc="連續作答,全程不揭曉正解;交卷後才看整體成績與逐題檢討 —— 適合考前自我測驗。"
	onClick={() => setExamDialogOpen(true)}
/>
{examDialogOpen && (
	<StartDialog
		initialMode="exam"
		onClose={() => setExamDialogOpen(false)}
	/>
)}
```

改成：

```tsx
<ModeCard
	icon={<Timer size={18} aria-hidden="true" />}
	title="全真模式"
	desc="連續作答,全程不揭曉正解;交卷後才看整體成績與逐題檢討 —— 適合考前自我測驗。"
	onClick={() => navigate("/smear/exam")}
/>
```

**Step 3：確認 `StartDialog` import 還留著**

`Smear.tsx` 另一處（約第 438-444 行）還在用 `StartDialog(initialMode="review")`
（錯題本「重練弱點主題」流程），import 不要刪。`grep -n "StartDialog"
frontend/src/routes/Smear.tsx` 應該剩下那一處引用。

**Step 4：型別檢查**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 無錯誤。

---

## Task 5：更新既有 e2e 測試裡的「全真」導覽路徑

**Files:**
- Modify: `frontend/e2e/smear-practice.test.mjs`

有三處測試流程是「進 `/smear` → 點『全真模式』按鈕 → 直接看到 StartDialog」。
改變之後,點下去會先導去 `/smear/exam`,要多一步「點『開始全真模式』」才會
看到對話框。

**Step 1：改第一處（約第 581-589 行）**

```js
await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });

await page.getByRole('button', { name: '全真模式' }).click();
await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
```

改成：

```js
await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });

await page.getByRole('button', { name: '全真模式' }).click();
await page.waitForURL('**/smear/exam', { timeout: 10_000 });
await page.getByRole('button', { name: '開始全真模式' }).click();
await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
```

（後面 `page.getByLabel('題數').fill('5')` 等步驟不變。）

**Step 2：改第二處（約第 682-687 行，同一種模式）**

```js
await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '全真模式' }).click();
await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
```

改成：

```js
await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '全真模式' }).click();
await page.waitForURL('**/smear/exam', { timeout: 10_000 });
await page.getByRole('button', { name: '開始全真模式' }).click();
await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
```

**Step 3：改第三處（約第 864-867 行）**

```js
await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });

await page.getByRole('button', { name: '全真模式' }).click();
await page.getByText('主題資料格式不正確').waitFor({ timeout: 10_000 });
```

改成：

```js
await page.goto(`${server.origin}/smear`, { waitUntil: 'domcontentloaded' });

await page.getByRole('button', { name: '全真模式' }).click();
await page.waitForURL('**/smear/exam', { timeout: 10_000 });
await page.getByRole('button', { name: '開始全真模式' }).click();
await page.getByText('主題資料格式不正確').waitFor({ timeout: 10_000 });
```

**Step 4：確認沒有漏掉其他處**

```bash
grep -n "name: '全真模式' }).click" frontend/e2e/smear-practice.test.mjs
```

三處都應該緊接著出現 `waitForURL('**/smear/exam'`。

**Step 5：跑這支 e2e 確認全部通過**

```bash
cd frontend && pnpm build && node --test e2e/smear-practice.test.mjs
```

Expected: 全數 PASS（這支需要先 build，`smear-practice.test.mjs` 跑的是打包
後的正式版）。

---

## Task 6：新增一條 e2e 斷言「全真真的有自己的網址」+ 收尾 commit

**Files:**
- Modify: `frontend/e2e/smear-practice.test.mjs`

**Step 1：加一條最小斷言，釘住 Layer 1 的核心結論**

在既有測試檔案結尾（`test(...)` 區塊之間，找一個空隙,例如緊接在第一個修改過
的測試之後）加一條新測試：

```js
test('全真模式有自己的網址,跟複習模式對稱', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  installSmearBackend(ctx, { mode: 'exam', questions: [question('sym-q1', DX.apl)], sessionId: 'sym-sess' });

  try {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/smear/exam`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '全真模式' }).waitFor();
    await page.getByRole('button', { name: '開始全真模式' }).click();
    await page.getByText('骨髓性').first().waitFor({ timeout: 10_000 });
  } finally {
    await ctx.close();
  }
});
```

這條驗的是「直接導到 `/smear/exam` 這個網址，頁面本身就能運作」——這正是
Layer 1 要解決的問題（全真原本沒有可以分享/加書籤的網址）。

**Step 2：跑完整套 smear e2e**

```bash
node --test e2e/smear-practice.test.mjs
```

Expected: 全數 PASS。

**Step 3：跑一次全站 e2e smoke（確認新路由沒有讓任何路由表斷掉）**

```bash
node --test e2e/smoke.test.mjs e2e/overflow.test.mjs
```

Expected: 全數 PASS（`overflow.test.mjs` 沒有理由變化，`/smear/exam` 不是
導覽階梯裡的新項目，只是既有「全真」按鈕的目的地換了）。

**Step 4：Commit**

```bash
cd /Users/htlin/hema-2026/.worktrees/smear-exam-parity
git add frontend/src/routes/SmearExam.tsx frontend/src/App.tsx \
  frontend/src/components/smear/SmearDashboard.tsx frontend/src/routes/Smear.tsx \
  frontend/e2e/smear-practice.test.mjs
git commit -m "$(cat <<'EOF'
feat(smear): 全真模式補一個真路由 /smear/exam，跟複習對稱

三個既有入口（底部導覽、首頁抹片卡、練習分頁）原本讓「全真」直接彈
StartDialog、沒有網址；「複習」已經是真路由。新增 SmearExam.tsx 落地頁
（跟 SmearReview.tsx 同款：路由 landing → 點按鈕開既有對話框），三個
入口改成導去這裡，StartDialog 本身不動。
EOF
)"
```

---

# Phase 2 — Layer 3：選擇題提示（複習模式）

## Task 7：把 `fisherYatesShuffle` 從 `smear-pick.ts` 匯出

**Files:**
- Modify: `worker/lib/smear-pick.ts`

**Step 1：加 `export`**

找到（約第 78 行）：

```ts
function fisherYatesShuffle<T>(items: T[], rng: () => number): T[] {
```

改成：

```ts
export function fisherYatesShuffle<T>(items: T[], rng: () => number): T[] {
```

（純粹加一個關鍵字，不改行為 —— 下一個任務要在 `smear-mcq.ts` 裡重用它，
不重寫第二份洗牌演算法。）

**Step 2：確認既有測試沒有壞**

```bash
node --test worker/lib/smear-pick.test.ts
```

Expected: 全數 PASS（這個改動不影響任何既有行為）。

**Step 3：Commit**

```bash
git add worker/lib/smear-pick.ts
git commit -m "$(cat <<'EOF'
refactor(smear): 匯出 fisherYatesShuffle，供下一個任務的 smear-mcq.ts 重用

只加一個 export 關鍵字，行為不變 —— 避免在新檔案裡重寫第二份洗牌演算法。
EOF
)"
```

---

## Task 8：TDD `pickMcqDistractors` / `pickMcqOptions`

**Files:**
- Create: `worker/lib/smear-mcq.ts`
- Create: `worker/lib/smear-mcq.test.ts`

**Step 1：先寫測試（會失敗，因為 `smear-mcq.ts` 還不存在）**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMcqDistractors, pickMcqOptions, type McqCandidate } from './smear-mcq.ts';

const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

const cand = (id: string, topic: string, label = id): McqCandidate => ({ id, topic, label });

test('同 topic 優先抽干擾項', () => {
  const correct = cand('dacrocyte', 'rbc', 'dacrocyte');
  const pool = [
    cand('schistocyte', 'rbc'),
    cand('spherocyte', 'rbc'),
    cand('target-cell', 'rbc'),
    cand('burr-cell', 'rbc'),
    cand('aml', 'myeloid'),
    cand('cll', 'lymphoid'),
  ];
  const got = pickMcqDistractors(correct, pool, 4, seq([0.1, 0.2, 0.3, 0.4, 0.5]));
  assert.equal(got.length, 4);
  // 四個同 topic 候選剛好等於名額，一個跨 topic 的都不該出現
  assert.ok(!got.includes('aml'));
  assert.ok(!got.includes('cll'));
});

test('⚠️ 同 topic 不足時，缺額要從其他 topic 回填 —— 不准少於 count', () => {
  const correct = cand('rare-dx', 'infection', 'rare-dx');
  const pool = [
    cand('other-infection', 'infection'),
    cand('aml', 'myeloid'),
    cand('cll', 'lymphoid'),
    cand('platelet-dx', 'platelet'),
    cand('storage-dx', 'other'),
  ];
  const got = pickMcqDistractors(correct, pool, 4, seq([0.1, 0.2, 0.3, 0.4]));
  assert.equal(got.length, 4); // 同 topic 只有 1 個候選，其餘 3 個從別 topic 回填
});

test('正解永遠不會出現在自己的干擾項清單裡', () => {
  const correct = cand('dacrocyte', 'rbc', 'dacrocyte');
  const pool = [correct, cand('schistocyte', 'rbc'), cand('spherocyte', 'rbc')];
  const got = pickMcqDistractors(correct, pool, 4, seq([0.1, 0.2]));
  assert.ok(!got.includes('dacrocyte'));
});

test('pickMcqOptions：正解一定在洗牌後的清單裡，且不重複', () => {
  const correct = cand('dacrocyte', 'rbc', 'dacrocyte-label');
  const pool = [
    cand('schistocyte', 'rbc', 'schistocyte-label'),
    cand('spherocyte', 'rbc', 'spherocyte-label'),
    cand('target-cell', 'rbc', 'target-cell-label'),
    cand('burr-cell', 'rbc', 'burr-cell-label'),
  ];
  const got = pickMcqOptions(correct, pool, seq([0.1, 0.2, 0.3, 0.4, 0.5]));
  assert.equal(got.length, 5);
  assert.equal(new Set(got).size, 5);
  assert.ok(got.includes('dacrocyte-label'));
});

test('題庫小到湊不出 4 個干擾項時，回傳能湊到的數量，不丟例外', () => {
  const correct = cand('only-dx', 'rbc', 'only-dx');
  const got = pickMcqDistractors(correct, [correct], 4, seq([0.1]));
  assert.equal(got.length, 0);
});
```

**Step 2：跑測試，確認失敗（模組不存在）**

```bash
node --test worker/lib/smear-mcq.test.ts
```

Expected: FAIL — `Cannot find module './smear-mcq.ts'`。

**Step 3：實作 `smear-mcq.ts`**

```ts
/**
 * 抹片練習「看選項」提示：從正解的同一個 topic 裡挑干擾項，同 topic 候選
 * 不足時從其他 topic 回填 —— 沿用 smear-pick.ts 的 largest-remainder 回填
 * 精神,但這裡只挑固定數量的干擾項,不是按比例分配題數,所以另開一支純函式
 * 而不是重用 pickSmearSet()。
 *
 * 正解與干擾項的組合必須在伺服器產生（見呼叫端 worker/routes/smear.ts 的
 * mc-options 端點）——這支函式本身不碰網路/D1，純粹是給定候選池挑幾個出來。
 */
import { fisherYatesShuffle } from "./smear-pick";

export interface McqCandidate {
  id: string;
  topic: string;
  label: string;
}

/**
 * 從 pool 裡挑 count 個干擾項(不含 correct 自己)。優先同 topic,不足則從
 * 其他 topic 回填。回傳的是 label(不是 id)——呼叫端只需要顯示用的文字。
 */
export function pickMcqDistractors(
  correct: McqCandidate,
  pool: McqCandidate[],
  count: number,
  rng: () => number,
): string[] {
  if (count <= 0) return [];

  const byId = new Map<string, McqCandidate>();
  for (const item of pool) {
    if (item.id !== correct.id && !byId.has(item.id)) byId.set(item.id, item);
  }
  const all = [...byId.values()];

  const sameTopic = all.filter((i) => i.topic === correct.topic);
  const otherTopic = all.filter((i) => i.topic !== correct.topic);

  const picked: McqCandidate[] = fisherYatesShuffle(sameTopic, rng).slice(0, count);
  const remaining = count - picked.length;
  if (remaining > 0) {
    picked.push(...fisherYatesShuffle(otherTopic, rng).slice(0, remaining));
  }

  return picked.map((i) => i.label);
}

/**
 * 正解 + 干擾項,洗牌後回傳給前端顯示的完整選項清單(不帶任何「哪一個是
 * 正解」的資訊 —— 呼叫端只能拿到這個陣列本身)。
 */
export function pickMcqOptions(
  correct: McqCandidate,
  pool: McqCandidate[],
  rng: () => number,
  distractorCount = 4,
): string[] {
  const distractors = pickMcqDistractors(correct, pool, distractorCount, rng);
  return fisherYatesShuffle([correct.label, ...distractors], rng);
}
```

**Step 4：跑測試，確認全過**

```bash
node --test worker/lib/smear-mcq.test.ts
```

Expected: 全數 PASS。

**Step 5：Commit**

```bash
git add worker/lib/smear-mcq.ts worker/lib/smear-mcq.test.ts
git commit -m "$(cat <<'EOF'
feat(smear): pickMcqDistractors/pickMcqOptions 純函式 —— 看選項提示的干擾項生成

同 topic 優先抽干擾項（白血球混白血球、紅血球混紅血球），不足時從其他
topic 回填，不靜默少於名額。正解位置由呼叫端另外洗牌，這支函式只負責
挑候選。
EOF
)"
```

---

## Task 9：新增 worker 端點 `POST /sessions/:id/mc-options`

**Files:**
- Modify: `worker/routes/smear.ts`

**Step 1：加 import**

找到（約第 6 行）：

```ts
import { pickSmearSet, type PoolItem } from "../lib/smear-pick";
```

下面加一行：

```ts
import { pickMcqOptions, type McqCandidate } from "../lib/smear-mcq";
```

**Step 2：加路由**

緊接在既有 `POST /sessions/:id/answer` 那個 handler（約第 384-479 行）結束
之後、`POST /sessions/:id/finish` 開始之前，插入：

```ts
// ---------------------------------------------------------------------------
// POST /api/smear/sessions/:id/mc-options —— 「看選項」提示,複習模式限定
//
// 只回傳洗牌過的選項文字陣列,不帶任何能推出「哪一個是正解」的欄位 ——
// 同 /answer 端點檔頭那套對抗性審查的精神。全真模式刻意拒絕:那個模式的
// 全部價值建立在交卷前不揭曉任何判定資訊上,而這支端點的回應本身就會讓
// 正解的文字出現在畫面上,跟「全真模式全程不揭曉」直接衝突。
// ---------------------------------------------------------------------------
smearRoutes.post("/sessions/:id/mc-options", async (c) => {
	const sid = c.req.param("id");
	const email = c.var.email;

	const session = await c.env.DB.prepare(
		"SELECT id, mode, question_ids FROM smear_sessions WHERE id = ? AND user_email = ?",
	)
		.bind(sid, email)
		.first<{ id: string; mode: "review" | "exam"; question_ids: string }>();
	if (!session) return c.json({ error: "not found" }, 404);
	if (session.mode !== "review") {
		return c.json({ error: "mc-options only available in review mode" }, 403);
	}

	const body = await c.req
		.json<{ questionId?: string }>()
		.catch(() => ({}) as Record<string, never>);
	if (!body.questionId) {
		return c.json({ error: "questionId is required" }, 400);
	}

	let questionIds: string[] = [];
	try {
		questionIds = JSON.parse(session.question_ids);
	} catch {
		questionIds = [];
	}
	const idx = resolveQuestionIdx(body.questionId, questionIds);
	if (idx < 0) {
		return c.json({ error: "question is not part of this session" }, 400);
	}
	const realQuestionId = questionIds[idx];

	const q = await c.env.DB.prepare(
		`SELECT sq.dx_id, sd.canonical_long, sd.topic
       FROM smear_questions sq JOIN smear_dx sd ON sd.id = sq.dx_id
       WHERE sq.id = ?`,
	)
		.bind(realQuestionId)
		.first<{ dx_id: string; canonical_long: string; topic: string }>();
	if (!q) return c.json({ error: "question not found" }, 404);

	const { results: poolRows } = await c.env.DB.prepare(
		"SELECT id, canonical_long, topic FROM smear_dx WHERE id != ?",
	)
		.bind(q.dx_id)
		.all<{ id: string; canonical_long: string; topic: string }>();

	const pool: McqCandidate[] = (poolRows ?? []).map((r) => ({
		id: r.id,
		topic: r.topic,
		label: r.canonical_long,
	}));

	const options = pickMcqOptions(
		{ id: q.dx_id, topic: q.topic, label: q.canonical_long },
		pool,
		Math.random,
	);

	return c.json({ options });
});

```

**Step 3：型別檢查**

```bash
cd /Users/htlin/hema-2026/.worktrees/smear-exam-parity
npx tsc --noEmit -p worker/tsconfig.json 2>/dev/null || npx tsc --noEmit
```

（用 repo 既有的方式跑 worker 端型別檢查即可;如果沒有獨立的
`worker/tsconfig.json`,用根目錄 `npx tsc --noEmit` 即可涵蓋。）

**Step 4：本機起 wrangler dev，手動打一次端點驗證形狀**

```bash
pnpm dev &
sleep 3
# 先建一個複習模式 session（需要真的登入,本機 dev 用 X-Dev-Email bypass）
curl -s -X POST http://localhost:8787/api/smear/sessions \
  -H "Content-Type: application/json" -H "X-Dev-Email: <你的 admin_email>" \
  -d '{"mode":"review","n":5,"form":"any","topics":[],"sources":["exam","ash","submission"]}'
```

拿到 `id` 跟 `question_ids[0]` 之後：

```bash
curl -s -X POST http://localhost:8787/api/smear/sessions/<id>/mc-options \
  -H "Content-Type: application/json" -H "X-Dev-Email: <你的 admin_email>" \
  -d '{"questionId":"<question_ids[0]>"}'
```

Expected: `{"options":["...","...","...","...","..."]}`，5 個不重複的字串。
再拿同一個 session id 但把 mode 想像成 exam（或另建一場 exam session 重打
一次）驗證回 403。

---

## Task 10：前端 API 函式 `fetchSmearMcqOptions`

**Files:**
- Modify: `frontend/src/lib/smearApi.ts`

**Step 1：在 `submitSmearAnswer` 附近加新函式**

找到（約第 148-163 行）：

```ts
export interface SmearAnswerAck {
	ok: true;
}

export function submitSmearAnswer(
```

在 `SmearAnswerAck` 介面之後、`submitSmearAnswer` 之前插入：

```ts
// ---------------------------------------------------------------------------
// POST /api/smear/sessions/:id/mc-options —— 「看選項」提示,複習模式限定
// ---------------------------------------------------------------------------
export interface SmearMcqOptionsResponse {
	options: string[];
}

export function fetchSmearMcqOptions(
	sessionId: string,
	questionId: string,
): Promise<SmearMcqOptionsResponse> {
	return api.post(`/api/smear/sessions/${sessionId}/mc-options`, { questionId });
}

```

**Step 2：型別檢查**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 無錯誤。

**Step 3：Commit（跟 Task 9 一起送，因為前後端這兩支是同一個端點的兩端）**

```bash
cd /Users/htlin/hema-2026/.worktrees/smear-exam-parity
git add worker/routes/smear.ts frontend/src/lib/smearApi.ts
git commit -m "$(cat <<'EOF'
feat(smear): POST /api/smear/sessions/:id/mc-options 端點

複習模式限定（全真模式回 403 —— 那個模式的價值建立在交卷前不揭曉任何
判定資訊上，這支端點的回應本身就會讓正解文字出現在畫面上）。只回傳洗牌
過的選項文字，不帶任何能推出正解位置的欄位，同 /answer 端點的既有審查
精神。干擾項用 pickMcqOptions()（Task 8），同 topic 優先。
EOF
)"
```

---

## Task 11：`AnswerInput.tsx` 加「看選項」+ 單選清單

**Files:**
- Modify: `frontend/src/components/smear/AnswerInput.tsx`

**Step 1：改 props 介面，加 `onRequestMcOptions`**

找到（約第 33-45 行）：

```tsx
export function AnswerInput({
	onSubmit,
	submitting,
	topicHint,
	mode,
}: {
	onSubmit: (value: string, hintUsed?: string) => void;
	submitting: boolean;
	/** 分類提示的顯示文字。undefined = 這一題沒有提示可用。 */
	topicHint?: string;
	/** 複習/全真 —— 「直接看答案」只在複習模式 render。 */
	mode: SmearMode;
}) {
```

改成：

```tsx
export function AnswerInput({
	onSubmit,
	submitting,
	topicHint,
	mode,
	onRequestMcOptions,
}: {
	onSubmit: (value: string, hintUsed?: string) => void;
	submitting: boolean;
	/** 分類提示的顯示文字。undefined = 這一題沒有提示可用。 */
	topicHint?: string;
	/** 複習/全真 —— 「直接看答案」只在複習模式 render。 */
	mode: SmearMode;
	/**
	 * 「看選項」提示 —— 打 POST /mc-options 拿 5 個洗牌過的選項文字。只在
	 * 複習模式由呼叫端(SmearSession.tsx)傳入;undefined 時整顆按鈕不 render
	 * (同「直接看答案」用 `mode === 'review'` 條件式 render 的理由:全真
	 * 模式要整個不在 DOM 裡,不是被 CSS 藏起來)。
	 *
	 * 這個元件不自己 import lib/smearApi —— API 呼叫留在 SmearSession.tsx,
	 * AnswerInput 維持純展示元件,跟其他 prop(onSubmit/topicHint)同一種
	 * 「頁面算好、往下傳純資料/callback」的作法。
	 */
	onRequestMcOptions?: () => Promise<string[]>;
}) {
```

**Step 2：加內部 state**

找到（約第 46-48 行）：

```tsx
	const [value, setValue] = useState("");
	const [hintShown, setHintShown] = useState(false);
	const inputId = useId();
```

改成：

```tsx
	const [value, setValue] = useState("");
	const [hintShown, setHintShown] = useState(false);
	const inputId = useId();

	// 「看選項」——選了選項之後整個輸入框換成單選清單,不是並存(見下面
	// render 那段的條件判斷)。三態:還沒觸發 / 載入中 / 已經拿到選項。
	// mcError 獨立於 submitError(送出答案失敗)之外,因為這是拿選項失敗,
	// 使用者這時候還沒送出任何答案。
	type McState =
		| { status: "hidden" }
		| { status: "loading" }
		| { status: "loaded"; options: string[] }
		| { status: "error" };
	const [mc, setMc] = useState<McState>({ status: "hidden" });
	const [mcChoice, setMcChoice] = useState<string | null>(null);

	async function requestMcOptions() {
		if (!onRequestMcOptions || submitting || mc.status === "loading") return;
		setMc({ status: "loading" });
		try {
			const options = await onRequestMcOptions();
			setMc({ status: "loaded", options });
			setMcChoice(null);
		} catch {
			setMc({ status: "error" });
		}
	}

	function backToTyping() {
		setMc({ status: "hidden" });
		setMcChoice(null);
	}
```

**Step 3：改 `submit()`，兩種來源合流**

找到（約第 50-54 行）：

```tsx
	function submit() {
		const v = value.trim();
		if (!v || submitting) return;
		onSubmit(v, hintShown ? "topic" : undefined);
	}
```

改成：

```tsx
	function submit() {
		if (submitting) return;
		if (mc.status === "loaded") {
			if (!mcChoice) return;
			onSubmit(mcChoice, "mc_choice");
			return;
		}
		const v = value.trim();
		if (!v) return;
		onSubmit(v, hintShown ? "topic" : undefined);
	}
```

**Step 4：render——選項模式下整段換掉輸入框**

找到目前的 `return (...)` 開頭那段（約第 63-88 行，輸入框那塊）：

```tsx
	return (
		<div className="space-y-3">
			<label htmlFor={inputId} className="sr-only">
				你的答案
			</label>
			<input
				id={inputId}
				type="text"
				inputMode="text"
				autoComplete="off"
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
				enterKeyHint="done"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						submit();
					}
				}}
				placeholder="輸入診斷或細胞名稱…"
				disabled={submitting}
				className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded-lg px-4 py-3 text-base text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent disabled:opacity-60"
			/>
```

改成（`mc.status === "loaded"` 時整段換成單選清單，其餘情況照舊）：

```tsx
	return (
		<div className="space-y-3">
			{mc.status === "loaded" ? (
				<>
					{/* 單選清單 —— name 相同的原生 radio group 本來就支援方向鍵在
					    選項間移動 + Enter/Space 選取,不需要另外接手把/鍵盤邏輯就有
					    基本的鍵盤互動。視覺語彙(圓角框線/選中變 accent 邊框)跟
					    QuestionCard 的選項列同一套語言,但這裡是獨立的小元件 ——
					    QuestionCard 綁死 MCQ 題目的資料形狀(收藏/信心/管理員編輯),
					    直接重用會把兩個完全不同的資料模型綁在一起。 */}
					<fieldset className="space-y-2">
						<legend className="sr-only">選一個診斷</legend>
						{mc.options.map((opt) => (
							<label
								key={opt}
								className={
									"flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition " +
									(mcChoice === opt
										? "border-accent bg-accent/5 dark:bg-accent/15 eink:border-2"
										: "border-ink-200 dark:border-ink-700 hover:border-ink-400 dark:hover:border-ink-500")
								}
							>
								<input
									type="radio"
									name="smear-mc-choice"
									className="mt-1 accent-[#a8442a]"
									checked={mcChoice === opt}
									onChange={() => setMcChoice(opt)}
									disabled={submitting}
								/>
								<span className="text-ink-900 dark:text-ink-100 break-words min-w-0">
									{opt}
								</span>
							</label>
						))}
					</fieldset>
					<button
						type="button"
						onClick={backToTyping}
						disabled={submitting}
						className="text-xs text-ink-500 dark:text-ink-400 underline decoration-dotted underline-offset-4 hover:text-accent disabled:opacity-40"
					>
						改用輸入
					</button>
				</>
			) : (
				<>
					<label htmlFor={inputId} className="sr-only">
						你的答案
					</label>
					<input
						id={inputId}
						type="text"
						inputMode="text"
						autoComplete="off"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						enterKeyHint="done"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								submit();
							}
						}}
						placeholder="輸入診斷或細胞名稱…"
						disabled={submitting}
						className="w-full border border-ink-200 dark:border-ink-700 dark:bg-ink-800 rounded-lg px-4 py-3 text-base text-ink-900 dark:text-ink-100 focus:outline-none focus:border-accent disabled:opacity-60"
					/>
				</>
			)}
```

**Step 5：按鈕列裡加「看選項」，並處理 loading/error 文案**

找到（約第 89-109 行，`提交答案` 按鈕跟 `提示` 按鈕那個 `<div className="flex ...">` 區塊）：

```tsx
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={submit}
					disabled={submitting || !value.trim()}
					className="flex-1 sm:flex-none px-5 py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
				>
					{submitting && <Loader2 size={14} className="animate-spin" />}
					提交答案
				</button>
				{topicHint && !hintShown && (
					<button
						type="button"
						onClick={() => setHintShown(true)}
						disabled={submitting}
						className="px-3 py-2.5 rounded-lg border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 text-sm hover:border-ink-400 inline-flex items-center gap-1 disabled:opacity-40"
					>
						<CircleHelp size={14} />
						提示
					</button>
				)}
			</div>
```

改成（送出按鈕的 disabled 條件要涵蓋「選項模式下還沒選」；「看選項」只在
`mode === 'review' && onRequestMcOptions` 且尚未載入/載入中 時顯示；載入中
文字改成「載入中…」；`mc.status === 'error'` 時顯示重試）：

```tsx
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={submit}
					disabled={
						submitting ||
						(mc.status === "loaded" ? !mcChoice : !value.trim())
					}
					className="flex-1 sm:flex-none px-5 py-2.5 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
				>
					{submitting && <Loader2 size={14} className="animate-spin" />}
					提交答案
				</button>
				{topicHint && !hintShown && mc.status === "hidden" && (
					<button
						type="button"
						onClick={() => setHintShown(true)}
						disabled={submitting}
						className="px-3 py-2.5 rounded-lg border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 text-sm hover:border-ink-400 inline-flex items-center gap-1 disabled:opacity-40"
					>
						<CircleHelp size={14} />
						提示
					</button>
				)}
				{mode === "review" &&
					onRequestMcOptions &&
					(mc.status === "hidden" || mc.status === "error" || mc.status === "loading") && (
						<button
							type="button"
							onClick={requestMcOptions}
							disabled={submitting || mc.status === "loading"}
							className="px-3 py-2.5 rounded-lg border border-ink-200 dark:border-ink-700 text-ink-600 dark:text-ink-300 text-sm hover:border-ink-400 inline-flex items-center gap-1 disabled:opacity-40"
						>
							{mc.status === "loading" && (
								<Loader2 size={14} className="animate-spin" />
							)}
							{mc.status === "error" ? "看選項(重試)" : "看選項"}
						</button>
					)}
			</div>
			{mc.status === "error" && (
				<p className="text-xs text-accent">載入選項失敗,請重試。</p>
			)}
```

**Step 6：型別檢查**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 無錯誤（`mode === "review" && onRequestMcOptions` 這個條件下
TypeScript 應該能正確把 `onRequestMcOptions` 縮成非 undefined，如果報型別
錯誤,改成先 `const requestOptions = onRequestMcOptions；if (!requestOptions) ...` 這種寫法即可）。

**Step 7：Commit**

```bash
git add frontend/src/components/smear/AnswerInput.tsx
git commit -m "$(cat <<'EOF'
feat(smear): AnswerInput 加「看選項」—— 複習模式提示鏈第四層

按下之後整個輸入框換成單選清單(不是並存)，選了再按送出，跟現有「提交
答案」是同一顆按鈕。原生 radio group 的方向鍵/Enter 本身就有基本鍵盤
互動，不需要另外接手把系統（那是更大的一塊工程，留作後續）。
EOF
)"
```

---

## Task 12：`SmearSession.tsx` 接上 `onRequestMcOptions`

**Files:**
- Modify: `frontend/src/routes/SmearSession.tsx`

**Step 1：加 import**

找到（約第 5-13 行）：

```tsx
import {
	fetchSmearSession,
	submitSmearAnswer,
	finishSmearSession,
	SMEAR_TOPIC_LABELS,
	type SmearSessionDetail,
	type SmearSessionQuestion,
	type SmearGradeResponse,
} from "../lib/smearApi";
```

改成：

```tsx
import {
	fetchSmearSession,
	submitSmearAnswer,
	finishSmearSession,
	fetchSmearMcqOptions,
	SMEAR_TOPIC_LABELS,
	type SmearSessionDetail,
	type SmearSessionQuestion,
	type SmearGradeResponse,
} from "../lib/smearApi";
```

**Step 2：傳新 prop 給 `<AnswerInput>`**

找到（約第 332-338 行）：

```tsx
<AnswerInput
	key={current.id}
	onSubmit={(value, hintUsed) => void handleSubmit(current, value, hintUsed)}
	submitting={submitting}
	topicHint={SMEAR_TOPIC_LABELS[current.topic] ?? current.topic}
	mode={session.mode}
/>
```

改成：

```tsx
<AnswerInput
	key={current.id}
	onSubmit={(value, hintUsed) => void handleSubmit(current, value, hintUsed)}
	submitting={submitting}
	topicHint={SMEAR_TOPIC_LABELS[current.topic] ?? current.topic}
	mode={session.mode}
	onRequestMcOptions={
		session.mode === "review"
			? () =>
					fetchSmearMcqOptions(session.id, current.id).then((r) => r.options)
			: undefined
	}
/>
```

**Step 3：型別檢查**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 無錯誤。

**Step 4：Commit**

```bash
cd /Users/htlin/hema-2026/.worktrees/smear-exam-parity
git add frontend/src/routes/SmearSession.tsx
git commit -m "$(cat <<'EOF'
feat(smear): SmearSession 接上「看選項」—— 只在複習模式傳入

onRequestMcOptions 只在 session.mode === 'review' 時給一個真的函式，
全真模式傳 undefined，AnswerInput 那邊的按鈕因此整個不 render。
EOF
)"
```

---

## Task 13：更新 e2e mock backend + 新增「看選項」e2e 測試

**Files:**
- Modify: `frontend/e2e/smear-practice.test.mjs`

**Step 1：mock backend 加 `mc-options` 分支**

找到 `installSmearBackend` 裡 `sub === 'answer'` 那個 if 區塊之前（約第 288
行之前），插入：

```js
    if (sub === 'mc-options' && method === 'POST') {
      if (state.mode !== 'review') return json({ error: 'forbidden' }, 403);
      const body = JSON.parse(req.postData() || '{}');
      const idx = resolveIdx(state.questions, body.questionId);
      const q = state.questions[idx];
      // 固定不洗牌 —— 測試只需要「正解確實在清單裡」跟「選了正解會判對」，
      // 不需要驗證洗牌演算法本身(那是 worker/lib/smear-mcq.test.ts 的事)。
      const distractors = ['Distractor A', 'Distractor B', 'Distractor C', 'Distractor D'];
      return json({ options: [q.canonical_long, ...distractors] });
    }

```

**Step 2：確認 `resolveIdx` 這個 mock 端的輔助函式已經存在**

`grep -n "function resolveIdx" frontend/e2e/smear-practice.test.mjs` ——
`/answer` 分支已經在用它解析 `body.questionId`，同一個函式直接重用即可，
不用新增。

**Step 3：加一支新測試——看選項 → 選正解 → 判定全對**

在既有的複習模式測試（約第 370-420 行那支「完整走一次複習模式」附近）之後
新增：

```js
test('看選項提示:輸入框換成單選清單,選正解會判對,可以改回輸入', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  const questions = [question('mc-q1', DX.apl)];
  installSmearBackend(ctx, { mode: 'review', questions, sessionId: 'mc-sess' });

  try {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/smear/s/mc-sess`, { waitUntil: 'domcontentloaded' });

    const input = page.getByPlaceholder('輸入診斷或細胞名稱…');
    await input.waitFor();

    // 空掃防線:先確認「看選項」按鈕真的找得到,再點它。
    const mcButton = page.getByRole('button', { name: '看選項' });
    await mcButton.waitFor();
    await mcButton.click();

    // 輸入框應該不見了,單選清單取而代之。
    assert.equal(await input.count(), 0, '選項模式下,原本的輸入框應該不在 DOM 裡');
    const correctOption = page.getByRole('radio', { name: DX.apl.canonical_long });
    await correctOption.waitFor();

    // 改回輸入 —— 驗證退路真的有效。
    await page.getByRole('button', { name: '改用輸入' }).click();
    await input.waitFor();
    assert.equal(
      await page.getByRole('radio').count(),
      0,
      '改用輸入之後,選項清單應該整個消失',
    );

    // 再次觸發,這次真的選正解送出。
    await mcButton.click();
    await correctOption.waitFor();
    await correctOption.check();
    await page.getByRole('button', { name: '提交答案' }).click();

    await page.locator('[data-testid="grade-reveal"]').waitFor();
    await page.getByText('完全正確').first().waitFor();
  } finally {
    await ctx.close();
  }
});

test('全真模式不該有「看選項」按鈕(role 查詢 + DOM 掃描)', async (t) => {
  if (guard(t)) return;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  installSmearBackend(ctx, { mode: 'exam', questions: [question('mc-exam-q1', DX.apl)], sessionId: 'mc-exam-sess' });

  try {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/smear/s/mc-exam-sess`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('輸入診斷或細胞名稱…').waitFor();

    assert.equal(
      await page.getByRole('button', { name: '看選項' }).count(),
      0,
      '全真模式不該有「看選項」按鈕(role 查詢)',
    );
    const html = await page.content();
    assert.ok(!html.includes('看選項'), '全真模式的「看選項」要整個不在 DOM 裡');
  } finally {
    await ctx.close();
  }
});
```

（如果 `DX.apl.canonical_long` 這個欄位在既有測試檔的 `DX` fixture 常數裡
名稱不同，先 `grep -n "const DX" frontend/e2e/smear-practice.test.mjs` 確認
實際欄位名再對應調整——不要憑猜測硬套。）

**Step 4：先確認新測試會如預期失敗一次**

在還沒做 Task 9-12 之前執行這支測試應該是 FAIL（因為前端還沒有「看選項」
按鈕）。既然這幾個任務已經依序做完，這裡改成正面驗證：

```bash
cd frontend && pnpm build && node --test e2e/smear-practice.test.mjs
```

Expected: 全數 PASS，包含這兩支新測試。

**Step 5：Commit**

```bash
cd /Users/htlin/hema-2026/.worktrees/smear-exam-parity
git add frontend/e2e/smear-practice.test.mjs
git commit -m "$(cat <<'EOF'
test(smear): e2e 覆蓋「看選項」——選項清單/改回輸入/全真模式沒有這顆按鈕

mock backend 固定不洗牌回應（洗牌演算法本身由 smear-mcq.test.ts 守），
只驗證前端接線：選正解判對、退路真的清空選項、全真模式整個不在 DOM 裡。
EOF
)"
```

---

## Task 14：全套回歸 + WebKit smoke

**Files:** 無新改動，純驗證。

**Step 1：全部純函式測試**

```bash
cd /Users/htlin/hema-2026/.worktrees/smear-exam-parity
pnpm test
```

Expected: 全數 PASS（含 Task 7/8 新增的測試）。

**Step 2：全部 smear 相關 e2e**

```bash
cd frontend
node --test e2e/smear-practice.test.mjs e2e/eink.test.mjs e2e/overflow.test.mjs e2e/smoke.test.mjs
```

Expected: 全數 PASS。`eink.test.mjs` 這條特別要看——`/smear/exam` 是新路由，
如果它有進那支測試的路由表就會被順帶掃到；如果沒有，不需要現在加（Layer 1
只是換了一個既有對話框的入口，沒有新增「從未被掃過的畫面」，跟 CLAUDE.md
「歷屆考題面板」那節提醒的情況不同——那裡是提醒「加新分頁時要問這一頁有沒有
哪一塊從來沒被掃過」,而 `/smear/exam` 呈現的內容跟 `StartDialog` 本身在其他
路由早就掃過了)。

**Step 3：WebKit smoke（新路由一定要過這關，見 CLAUDE.md「Frontend changes
must be verified on WebKit」那節——過去真的出過 Chromium 綠、iOS 全白的事故）**

```bash
cd /Users/htlin/hema-2026/.worktrees/smear-exam-parity
pnpm test:webkit
```

Expected: 全數 PASS。如果 `/smear/exam` 沒有 fixture（`frontend/e2e/fixtures/`
底下沒有對應檔案），這支測試會列出「無 fixture」但不會因此失敗——不需要為
這個純前端路由額外造一個 API fixture。

**Step 4：修掉任何浮出來的問題再繼續**（如果有失敗，回對應任務修正，不要
跳過這一步直接往下走）。

---

## Task 15：補一節 CLAUDE.md，記錄這兩個決定的「為什�麼」

**Files:**
- Modify: `CLAUDE.md`

**Step 1：加一節**

在 CLAUDE.md「講義書籤」跟「其他筆記」之間，或任何一個合理的段落分界處
（跟其他 `###` 小節同一層級），加入：

```markdown
### 抹片 × 筆試操作一致性：入口對稱與看選項提示

`docs/plans/2026-09-05-smear-exam-parity-design.md`。抹片練習跟筆試 MCQ
在**資料層**刻意完全分開（見上面「抹片練習」那節），但首頁改成抹片主力
落地頁之後，**互動層**的落差開始被感受到：用慣筆試的人進到抹片會覺得
「同樣的動作,這裡卻不一樣」。

**入口對稱（`/smear/exam`）。** 底部導覽/首頁抹片卡/練習分頁的「複習」都是
真路由，「全真」原本只是一顆按鈕直接彈 `StartDialog`，沒有網址——同一個
位置、同一個圖示，行為卻不同。新增 `SmearExam.tsx`，跟 `SmearReview.tsx`
同一套心智模型（路由 landing → 點按鈕開既有的 `StartDialog`），三個既有
入口改指向這裡。`StartDialog` 本身一行沒動——這正是選它而不是把對話框整個
搬成頁面表單的理由：跟 `/smear/review` 已經確立的慣例一致，改動面積最小。

**看選項提示（複習模式提示鏈第四層）。** 現有提示鏈只有「主題分類」跟
「直接看答案」兩層,中間空了一大段——主題分類太籠統,直接看答案又太重。
新增 `POST /api/smear/sessions/:id/mc-options`（複習模式限定,全真回 403：
那個模式的價值建立在交卷前不揭曉任何判定資訊上,這支端點的回應本身就會讓
正解文字出現在畫面上,兩者直接衝突）,回傳 5 個洗牌過的選項文字,不帶任何
能推出正解位置的欄位——同 `/answer` 端點既有的對抗性審查精神。

干擾項生成（`worker/lib/smear-mcq.ts` 的 `pickMcqOptions()`）沿用既有
`topic` 分類軸（白血球混白血球、紅血球混紅血球），同 topic 不足 4 個時從
其他 topic 回填，不靜默少於名額——同 `pickSmearSet()` 缺額回填的精神，
兩支函式因此共用同一個 `fisherYatesShuffle()`。

⚠️ **原本設想「選對了不能算進拼字正確率」，查過現有程式碼才發現這個數字
目前根本不存在於複習模式。** 「拼字完全正確：N 題」只在全真模式交卷時算
（`SmearResult.tsx` 讀 `finish` 回應的 `spelling_ok`），複習模式沒有交卷、
沒有 session 完成的概念，沒有任何聚合會讀到 `hint_used='mc_choice'` 的列。
**這個原則留著給未來**：複習模式如果哪天長出「拼字正確率」這種聚合統計，
那支查詢要排除 `hint_used = 'mc_choice'` 的列——理由跟「直接看答案」被排除
在外一樣（那個數字答的是「你寫不寫得出來」,用選的沒有打字這回事）,但現在
加排除邏輯只是永遠不會被執行的防禦性程式碼。

前端這顆按鈕按下去,`AnswerInput.tsx` 的自由輸入框**整個換成**單選清單
（不是並存），選了再按送出——跟輸入框共用同一顆「提交答案」按鈕。**刻意
不重用 `QuestionCard` 的選項元件**：那個元件綁死 MCQ 題目的資料形狀
（收藏/信心/管理員編輯），硬套會把兩個不同的資料模型綁在一起，改成視覺
語彙一致的獨立小元件。原生 `<input type="radio">` 同 `name` 群組本身就有
方向鍵移動 + Enter/Space 選取的鍵盤互動，**不需要接上全站的手把系統就有
基本的鍵盤操作**——真正的手把（十字鍵/面鍵）整合是更大的一塊工程（那一套
綁定分散在 `QuestionCard`/`Question.tsx` 兩層,且需要新的情境判斷),這裡
刻意留給下一輪。
```

**Step 2：確認格式跟既有小節一致**

`###` 層級、粗體、⚠️ 標記的用法都要跟緊鄰的段落一致——不要引入新的排版
慣例。

**Step 3：Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: 記錄抹片×筆試入口對稱與看選項提示的設計決定

CLAUDE.md 目前唯一一個規模這麼大卻沒有被記錄的功能區塊終於補上——
往後改這兩塊之前，這裡先講清楚為什麼「全真」原本沒有網址、為什麼
拼字正確率的排除邏輯目前是留給未來而非現在的實作。
EOF
)"
```

---

## 完成後的狀態確認

```bash
cd /Users/htlin/hema-2026/.worktrees/smear-exam-parity
git log --oneline main..HEAD
pnpm test && (cd frontend && pnpm build) && pnpm test:webkit
```

Expected: 8-9 個 commit（Layer 1 一個、Layer 3 六個、文件一個），
全部測試通過。完成後回主 session 討論要不要開 PR，或接著做 Layer 2。
