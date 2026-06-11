export const meta = {
  name: 'hema-select5',
  description: 'Per question: pick the 5 highest-yield board-exam cards from the 12 in final/<id>.json -> final5/<id>.json',
  phases: [
    { title: 'Plan', detail: 'list ids without final5 file' },
    { title: 'Select', detail: 'pick best 5 cards per question (batches of 12)' },
  ],
}

const TODO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['todo'],
  properties: { todo: { type: 'array', items: { type: 'string' } } },
}
const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['id', 'n_cards', 'wrote'],
  properties: { id: { type: 'string' }, n_cards: { type: 'integer' }, wrote: { type: 'boolean' } },
}

function PROMPT(id) {
  return `你是台灣血液專科 board exam 名師。題目 ${id} 目前有 12 張左右的卡,使用者覺得太多、複習不完,要你<b>精選出「最高價值的 5 張」</b>(寧缺勿濫,品質第一)。

步驟:
1. Read /tmp/hema_anki/final/${id}.json (含 topic_index、extra_tags、enrich_html、cards[12+])。
2. 從現有 cards 中<b>挑出最值得記、最常考、最 high-yield 的 5 張</b>。挑選原則:
   - 優先保留:① 本題真正被考的<b>核心概念</b> ② 關鍵<b>診斷準則/數值 cutoff/分類門檻</b> ③ 最重要的<b>治療/處置 (首選藥)</b> ④ 最容易錯的<b>distractor 陷阱</b> ⑤ 最高影響的<b>機轉或預後</b>。
   - 捨棄:重複、瑣碎、過於簡單(背景常識)、太冷門的卡。
   - 5 張之間要<b>互補、涵蓋面廣</b>,不要 5 張都在講同一點。
3. 可<b>輕微潤飾</b>被選中的卡使其更精準、自成一體(<b>嚴禁「本例/本題/此例/此題」</b>),但不得竄改醫學事實。維持「簡問 / 簡答 / <hr> 補脈絡」格式;列舉可用 Cloze。
4. <b>原樣保留</b> topic_index、extra_tags、enrich_html(footer 不動)。
5. Write /tmp/hema_anki/final5/${id}.json (合法 JSON):
{"id":"${id}","topic_index":<原值>,"extra_tags":<原陣列>,"enrich_html":<原 footer 字串>,"cards":[<精選的 5 張>]}
6. 回傳 summary(id, n_cards=5, wrote=true)。`
}

phase('Plan')
const todoRes = await agent(
  'Read /tmp/hema_anki/ids.json (300 ids). List files in /tmp/hema_anki/final5/ (named <id>.json). Return {"todo":[ids without a final5/<id>.json]} in ids.json order.',
  { schema: TODO_SCHEMA, label: 'plan-todo', phase: 'Plan' }
)
const todo = todoRes.todo
log(`select5: ${todo.length} questions to trim to 5 cards`)

phase('Select')
const done = []
const BATCH = 12
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH)
  const rs = await parallel(batch.map((id, j) => () =>
    agent(PROMPT(id), { schema: SUMMARY_SCHEMA, label: `${id} (${i + j + 1}/${todo.length})`, phase: 'Select' })))
  for (const r of rs) if (r) done.push(r)
  log(`... ${Math.min(i + BATCH, todo.length)}/${todo.length} trimmed`)
}
log(`select5 done: ${done.length}/${todo.length}`)
return { trimmed: done.length, input: todo.length, summaries: done }
