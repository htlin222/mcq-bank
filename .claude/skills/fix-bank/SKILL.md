---
name: fix-bank
description: Fix typos / garbled text in a hema-2026 exam question reported through the in-app feedback button (a GitHub issue). Use when the user says "fix issue N", "fix the feedback", or points at a mcq-bank issue about a question having 錯字 / wrong text. This corrects wording only — for wrong ANSWERS use the verdict-by-oe skill instead.
---

# fix-bank

Repeatable process for fixing a question's **text** (typos, OCR garble, wording)
reported via the in-app 回報 button, which files a GitHub issue in the repo set by
`GH_FEEDBACK_REPO` in `wrangler.toml` (currently `htlin222/mcq-bank`).

**Scope guard:** this skill only rewrites `stem` / `options_json`. It does **not**
change `answer`. If the report disputes the correct answer, stop and use the
`verdict-by-oe` skill instead.

## Key facts

- **D1 database name:** read it, never hardcode — `grep database_name wrangler.toml`
  (currently `hema-2026-db`). Binding is `DB`.
- **Questions table columns:** `id` (e.g. `114-022`), `year`, `number`, `stem`,
  `options_json`, `answer`, `group`.
- **options_json shape:** `[{"key":"A","text":"..."},{"key":"B","text":"..."}, ...]`.
- **Remote D1 needs a token:** load it from `.env` before every remote command:
  `set -a && . ./.env && set +a`.
- The reported URL looks like `.../q/114-022` — the question id is the last segment.
- The issue **owner comment often contains the corrected text** — treat that as
  the source of truth, then additionally fix any residual obvious typos.

## Steps

### 1 — Read the issue

```bash
gh issue view <N> --repo htlin222/mcq-bank --json title,body,labels,comments
```

Extract the **question id** from the URL in the body (segment after `/q/`).
Read every comment: the owner frequently pastes the intended stem + options.

### 2 — Read current DB content (remote is prod)

```bash
DB=$(grep -m1 database_name wrangler.toml | sed 's/.*"\(.*\)".*/\1/')
set -a && . ./.env && set +a
wrangler d1 execute "$DB" --remote --json \
  --command "SELECT id, stem, options_json, answer FROM questions WHERE id='<ID>'" 2>/dev/null
```

Diff the DB text against the owner's corrected text. Decide the final wording:
1. Base = owner's corrected text if provided, else your best reconstruction.
2. Also fix residual unambiguous errors (medical terms, 錯字). Common ones seen:
   `Cobolamin→Cobalamin`, `homocystein→homocysteine`, `筆因→肇因`,
   `ASMATS13→ADAMTS13`. When a fix is a judgement call, still apply it but list
   it explicitly in the close comment so the owner can object.

### 3 — Write an UPDATE .sql file

Write to the scratchpad (avoids shell-escaping hell). JSON has no single quotes,
so wrap values in single quotes. Use full-width Chinese parens `（）` as the owner does.

```sql
UPDATE questions
SET stem = '<corrected stem>',
    options_json = '[{"key":"A","text":"..."},{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."},{"key":"E","text":"..."}]'
WHERE id = '<ID>';
```

Do **not** touch `answer` (see scope guard).

### 4 — Apply to remote, then verify

```bash
set -a && . ./.env && set +a
wrangler d1 execute "$DB" --remote --file <scratchpad>/fix-<ID>.sql 2>/dev/null
wrangler d1 execute "$DB" --remote --json \
  --command "SELECT stem, options_json FROM questions WHERE id='<ID>'" 2>/dev/null \
  | python3 -c "import sys,json; r=json.load(sys.stdin)[0]['results'][0]; print(r['stem']); [print(o['key'],o['text']) for o in json.loads(r['options_json'])]"
```

Confirm `Rows written` = 2 (stem + options_json) and the printout reads correctly.

### 5 — Mirror to local D1

Keeps `.wrangler/state` in sync so local dev shows the fix.

```bash
wrangler d1 execute "$DB" --local --file <scratchpad>/fix-<ID>.sql 2>/dev/null
```

### 6 — Close the issue with a changelog

```bash
gh issue close <N> --repo htlin222/mcq-bank --comment "已修正 <ID> 的錯字。
<one line on the root cause, e.g. OCR 亂碼 / 個別錯字>
主要修正：
- \`old\` → \`new\`
...
答案維持 <X>。remote + local D1 皆已更新。"
```

## Notes

- This edits D1 directly — there is no code change to commit.
- Re-importing questions from CSV can clobber DB edits (see the
  `import-clobbers-promoted-answer` memory). If the fix must survive a re-import,
  also update the source CSV/import for that id.
- Only touching text → answer stays. Any answer dispute → hand off to
  `verdict-by-oe`.
