---
name: verdict-by-oe
description: Use when auditing or fixing hema-2026 question answers with OpenEvidence MCP: read the question from D1, ask OpenEvidence for a verdict, report pending answer/explanation changes for user approval, then update D1 with history.
---

# Verdict By OE

Use this skill in the `hema-2026` repo when the user asks to audit, re-check,
verdict, or fix a question answer using OpenEvidence.

## Guardrails

- Do not update D1 on the first pass. Read the DB, ask OpenEvidence, and report
  the pending verdict first.
- Only update D1 after the user explicitly approves the specific answer and/or
  explanation change.
- Use `ppoiu87@gmail.com` as `changed_by` / `updated_by` for approved admin
  corrections unless the user provides another identity.
- Prefer the production D1 database: `wrangler d1 execute hema-2026-db --remote`.
  Use local D1 only when the user asks for local work.
- Treat medical conclusions as evidence-supported verdicts, not blind MCP output.
  If OE misses a NOT/EXCEPT stem, contradicts itself, lacks the needed option
  detail, or the prompt data is incomplete, mark the verdict `needs_review`.
- Do not touch unrelated git changes. DB-only fixes usually do not require a
  commit unless repo files changed.

## Workflow

1. Read the question and current explanation from D1.

   ```sh
   wrangler d1 execute hema-2026-db --remote --json --command \
     "SELECT q.id, q.year, q.answer, q.stem, q.options_json,
             e.version AS explanation_version, e.content_json AS explanation_json
      FROM questions q
      LEFT JOIN explanations e ON e.question_id = q.id
      WHERE q.id = '114-007';"
   ```

   Confirm that the stem and options are complete. If coded options refer to
   missing numbered statements, report `data_quality_missing_stem` and stop
   before asking for an answer correction.

2. Ask OpenEvidence MCP for a focused verdict.

   Use the OpenEvidence MCP `oe_ask` tool. Keep the prompt focused and include:
   question id, exact stem, all options, current DB answer, and the requested
   output schema.

   Request structured output like:

   ```json
   {
     "id": "114-007",
     "current_answer": "B",
     "best_answer": "E",
     "verdict": "agree | disagree | uncertain | needs_review",
     "confidence": "high | medium | low",
     "reason": "short rationale",
     "option_notes": {
       "A": "why right/wrong",
       "B": "why right/wrong"
     },
     "article_id": "OpenEvidence article id if available"
   }
   ```

   For many questions, batch only when the combined prompt stays easy to audit;
   otherwise handle questions one at a time.

3. Normalize the verdict before reporting it.

   - `agree`: OE supports the current answer with coherent reasoning.
   - `disagree`: OE identifies a different valid option with coherent reasoning.
   - `uncertain`: evidence is incomplete, conflicting, or low confidence.
   - `needs_review`: the question text/options are incomplete, OE likely missed
     a logical qualifier, or the answer depends on a local exam convention.

4. Report the pending result to the user before any write.

   Include:

   - Question id.
   - Current DB answer.
   - Proposed answer, if any.
   - Confidence and verdict.
   - One concise paragraph of medical/option reasoning.
   - OpenEvidence article id or citation handle, if present.
   - Proposed explanation changes when the explanation should change.
   - The explicit line: `No DB change has been made yet.`

   Ask for explicit approval only when a DB write is needed.

5. Update D1 after approval.

   Before writing, re-read the current row so the update is based on the latest
   DB state. Use a temp SQL file for multi-statement updates and escape strings
   through a real JSON/SQL helper, not manual editing.

   Minimum answer-change pattern:

   ```sql
   INSERT INTO answer_history
     (question_id, previous_answer, new_answer, source, challenge_id, changed_by, changed_at)
   SELECT id, answer, answer, 'original', NULL, NULL,
          strftime('%s','now') * 1000
   FROM questions
   WHERE id = '<QID>'
     AND NOT EXISTS (SELECT 1 FROM answer_history WHERE question_id = '<QID>');

   INSERT INTO answer_history
     (question_id, previous_answer, new_answer, source, challenge_id, changed_by, changed_at)
   SELECT id, answer, '<NEW_ANSWER>', 'admin', NULL, 'ppoiu87@gmail.com',
          strftime('%s','now') * 1000
   FROM questions
   WHERE id = '<QID>' AND answer <> '<NEW_ANSWER>';

   UPDATE questions
   SET answer = '<NEW_ANSWER>'
   WHERE id = '<QID>' AND answer <> '<NEW_ANSWER>';

   UPDATE answer_challenges
   SET status = 'archived',
       resolved_at = strftime('%s','now') * 1000,
       resolution_reason = 'admin:answer-edit'
   WHERE question_id = '<QID>' AND status IN ('open', 'contested');
   ```

   Explanation-change pattern when the explanation row exists:

   ```sql
   UPDATE explanations
   SET content_json = '<TIPTAP_JSON>',
       version = COALESCE(version, 0) + 1,
       updated_by = 'ppoiu87@gmail.com',
       updated_at = strftime('%s','now') * 1000,
       editing_by = NULL,
       editing_until = NULL,
       stale_since = NULL
   WHERE question_id = '<QID>';

   INSERT INTO explanation_history (question_id, version, content_json, updated_by, updated_at)
   SELECT question_id, version, content_json, updated_by, updated_at
   FROM explanations
   WHERE question_id = '<QID>';
   ```

   If the explanation row is missing, insert version `1` and then snapshot that
   inserted row instead of running the update:

   ```sql
   INSERT INTO explanations (question_id, content_json, version, updated_by, updated_at, stale_since)
   VALUES ('<QID>', '<TIPTAP_JSON>', 1, 'ppoiu87@gmail.com',
           strftime('%s','now') * 1000, NULL);

   INSERT INTO explanation_history (question_id, version, content_json, updated_by, updated_at)
   SELECT question_id, version, content_json, updated_by, updated_at
   FROM explanations
   WHERE question_id = '<QID>';
   ```

   If the repo has active answer challenges for this question, archive or resolve
   them according to the current table schema after confirming column names.

6. Verify the write.

   Query the changed row, answer history, and explanation history:

   ```sh
   wrangler d1 execute hema-2026-db --remote --json --command \
      "SELECT id, answer FROM questions WHERE id = '<QID>';
      SELECT question_id, previous_answer, new_answer, source, challenge_id, changed_by, changed_at
      FROM answer_history WHERE question_id = '<QID>' ORDER BY changed_at;
      SELECT question_id, version, updated_by, updated_at
      FROM explanations WHERE question_id = '<QID>';
      SELECT question_id, version, updated_by, updated_at
      FROM explanation_history WHERE question_id = '<QID>' ORDER BY updated_at;"
   ```

   Also inspect the rendered TipTap text if explanation JSON changed.

7. Final response.

   State exactly what changed, the verified answer/version, the OE article id,
   and whether any repo files were changed. Mention unrelated staged files only
   if they remain present and were intentionally untouched.
