# Explanation Polish Spec (for Haiku subagents)

## Goal

For each question in `years/<YEAR>/batches/batch-*.json`, rewrite the
`explanation_md` field so that the resulting markdown is readable, structured,
and useful for a study group reviewing Taiwan hematology board exams.

The source `explanation_md` was produced by a scraping/conversion pipeline, so
it often:

- echoes the question stem + options at the top (DELETE this — it's duplicate)
- contains raw notes, fragments, or single-line hints
- mixes Chinese (繁體) and English medical terminology (KEEP both)
- includes `![alt](url)` image references (PRESERVE every one, byte-exact)
- contains references / citations (PRESERVE, lightly format)

## Output structure (per question)

```
**正解：(X) <option text or short paraphrase>**

<2–5 sentences of rationale: why X is correct, citing mechanism / classification /
study as appropriate. Use existing notes as your source — do NOT introduce new
clinical facts, drug names, or citations that aren't in the original.>

<Optional: bullet list briefly contrasting the other distractors if the
original notes give material to work with. Skip if you'd have to invent it.>

<Preserve original image references verbatim, each on its own line.>

<Preserve any reference / citation line at the bottom, lightly cleaned.>
```

### Light generation policy (Polish + Light Generation mode)

- If the source has **real content** (a paragraph, notes, comparisons): polish
  it into the structure above.
- If the source is **just a stem-echo with no real explanation** (e.g.
  `"WHO 2016 classification"` and nothing else): generate a brief 2–3 sentence
  rationale based on the question + answer + the fragment hint. Be conservative:
  if you don't actually know, write something like `**正解：(X) ...**` and a
  single sentence pointing at the hint (e.g. "依 WHO 2016 分類…"). Do NOT
  invent specific numbers, percentages, gene names, or citations.

## Hard rules

1. **Never invent citations.** No fake PMIDs, DOIs, journal names. If the
   original had a real citation, keep it. Otherwise omit.
2. **Never invent drug doses, lab cutoffs, percentages, mutation hotspots,
   or staging criteria** that aren't in the source.
3. **Preserve every image reference.** `![alt](/img/years/<YEAR>/<hash>.webp)`
   lines must appear in the output exactly as they appeared in the input
   (you may reorder them but text must match byte-for-byte).
4. **Delete the stem-echo prefix.** If `explanation_md` starts with the
   question stem and options (verbatim), strip that block — the reader already
   sees the question.
5. **Keep 繁體中文** (Traditional Chinese). Mixed Chinese-English medical
   terminology is idiomatic in Taiwan; preserve it.
6. **Markdown only**, using the supported subset:
   - `#`, `##`, `###` headings (use sparingly; usually no heading needed)
   - `**bold**`, `*italic*`, `` `code` ``
   - `- ` bullet lists
   - `1. ` ordered lists
   - `![alt](url)` images, `[text](url)` links
   - blank line = paragraph break
7. **No HTML tags. No tables.** (The converter doesn't support them.)
8. **No JSON formatting damage.** You're editing JSON files in place — only
   the value of the `explanation_md` string changes. All other fields
   (`number`, `stem`, `options`, `answer`, `tags`, `confidence`,
   `oe_consulted`) MUST remain byte-identical.

## What to do per batch file

For each `batch-*.json` file in your assigned year:

1. Read the file as JSON.
2. For each question object in the array:
   - Inspect `stem`, `options`, `answer`, `explanation_md`.
   - Produce a polished `explanation_md` per the rules above.
   - Replace only that field.
3. Write the file back as JSON, UTF-8, `indent=2`, `ensure_ascii=False`.
4. Verify the file is still valid JSON before moving to the next.

## Output expectations from the agent

When you finish, report:

- How many questions you polished
- Any questions you skipped (and why — e.g. explanation was already clean)
- Any anomalies (e.g. a question whose `explanation_md` was already empty)
- Sample diff: paste one before/after pair so the reviewer can spot-check

Do NOT run any wrangler / git commands — the user runs the re-seed step.
