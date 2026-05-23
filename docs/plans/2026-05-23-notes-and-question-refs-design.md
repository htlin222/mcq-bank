# 2026-05-23 — 個人筆記 + 已做筆記 category + @-question references

Three related features bundled because they share TipTap content storage,
extraction logic, and the same Question page surface.

## 1. 個人筆記 (private notes)

Like 詳解 共筆 but private to each user. Lives on the Question page as a
second tab next to 詳解共筆.

### Storage

New table:

```sql
CREATE TABLE personal_notes (
  user_email   TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  question_id  TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,           -- TipTap doc JSON
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_email, question_id)
);
CREATE INDEX idx_notes_by_user ON personal_notes(user_email, updated_at DESC);
```

Deliberately omitted vs. `explanations`: no `version`, no edit-lock, no
history. Single owner → last-write-wins. Index supports a "我的筆記" listing.

### API

- `PUT /api/questions/:id/note` — upsert `{ content_json }` for the
  current user.
- `DELETE /api/questions/:id/note` — remove the row.
- `GET /api/questions/:id` patched to return `my_note: { content_json,
  updated_at } | null`, matching how `my_progress` is inlined.

### UI

Replace the single 詳解共筆 section in `routes/Question.tsx` with a tab
strip:

```
[ 詳解共筆 ] [ 個人筆記 ]
┌────────────────────────────┐
│ (active tab content)        │
└────────────────────────────┘
```

Note tab has a plain edit / save flow — no lock badge, no version
display. RichEditor reused as-is. Mention picker still works (user
mentions in private notes are not pushed as notifications — see §3
"privacy decision").

## 2. 已做筆記 category in 我的收藏

Virtual sidebar entry between 未分類 and the folders separator. Lists
questions where the current user has a personal note.

```
全部                12
未分類               3
已做筆記             7   ← new virtual entry
─── 資料夾 ───
重要                 5
複習                 4
```

### API

- `GET /api/bookmarks?source=notes` — returns the same `Item[]` shape
  as the existing bookmarks endpoint, joining `personal_notes` instead
  of `bookmark_items`. `created_at` → `updated_at`. `folder_id` and
  `note` columns are null.
- `GET /api/folders` patched to include a top-level `notes_count` so
  the sidebar has the badge without an extra request.

### UI

- New constant `NOTES = '__notes__'`. Sidebar item between the existing
  全部/未分類 pair and the folder list.
- `loadItems` branches on `active === NOTES` and hits the new endpoint.
- `ItemMenu` is hidden in NOTES view (folder-move / 取消收藏 don't
  apply); the row remains a link to `/q/<id>`.

## 3. @-question references

When the user types `@` in any rich-text surface (詳解, 個人筆記, 留言),
a picker shows matching users and matching questions. Selecting a
question inserts a clickable `@YYY-NNN` link to `/q/YYY-NNN`.

### Trigger handling

Single `@` for both kinds. `mention-suggestion.ts` `items()` branches:

- query matches `^\d` → call `/api/questions/_meta/lookup?q=<query>`
  returning `{ kind: 'question', id, year, number, stem }[]` up to 8.
- otherwise → existing user lookup, returning
  `{ kind: 'user', email, display_name, avatar_key }[]`.

`MentionList` renders a small kind-switch (avatar + display_name for
users; `YYY-NNN` + truncated stem for questions). Selecting a question
inserts a `questionRef` node, not a `mention` node.

### TipTap

New extension `QuestionRef` (a Node, similar to Mention) added to
`tiptap-extensions.ts`. Stores `attrs.id = "114-001"`. Renders as
`<a class="qref" href="/q/114-001">@114-001</a>`. The extension is
shared by editable and read-only editors.

### Back-references

```sql
CREATE TABLE question_refs (
  source_type        TEXT NOT NULL,         -- 'explanation' | 'comment'
  source_id          TEXT NOT NULL,
  target_question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  by_email           TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (source_type, source_id, target_question_id)
);
CREATE INDEX idx_refs_by_target ON question_refs(target_question_id);
```

Save-time extraction mirrors `extractMentions()` in `worker/lib/db.ts`:
walk the TipTap JSON for `questionRef` nodes, collect target IDs, then
delete-and-reinsert rows for the (source_type, source_id) tuple to keep
the index in sync. Called from `explanations.ts` and `comments.ts` PUT
handlers.

### Privacy decision

Refs from `personal_notes` are **not indexed** — exposing them in the
target question's back-ref list would leak "user X cross-linked from
their private notes here", a study-pattern leak. If a personal "我引用
過的題目" view is needed later, it can read directly from the user's
own notes without a global index.

### UI

New section between 詳解/筆記 and 討論 on Question page:

```
被引用 (3)
─ 114-005 (alice@…)  · 2026-03-15
─ 114-012 (mark@…)   · 2026-03-12 · 留言
```

Hidden when empty.

## API summary

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/questions/:id` | + `my_note`, `back_refs` |
| PUT | `/api/questions/:id/note` | upsert personal note |
| DELETE | `/api/questions/:id/note` | remove personal note |
| GET | `/api/questions/_meta/lookup?q=` | autocomplete |
| GET | `/api/bookmarks?source=notes` | "已做筆記" list |
| GET | `/api/folders` | + `notes_count` |

## Anti-features (YAGNI)

- No history for personal notes.
- No locking for personal notes.
- No notifications for question refs.
- No edit-in-place from the bookmarks/notes list (click → question
  page → edit).
- No back-refs from personal notes (see privacy decision).
- No "我引用過的題目" view yet — can derive on demand from notes JSON.
