export const meta = {
  name: 'hema-final-seq',
  description: 'SEQUENTIAL per-question (one at a time, NO parallel): rewrite base cards self-contained (no 本例), top-up to >=10, WebSearch evidence, write footer -> final/<id>.json',
  phases: [
    { title: 'Plan', detail: 'list question ids without a final file' },
    { title: 'Finalize', detail: 'one question at a time: clean+topup>=10 cards + WebSearch footer' },
  ],
}

const TODO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['todo'],
  properties: { todo: { type: 'array', items: { type: 'string' } } },
}
const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'topic_index', 'n_cards', 'wrote'],
  properties: {
    id: { type: 'string' },
    topic_index: { type: 'integer', minimum: 1, maximum: 7 },
    n_cards: { type: 'integer' },
    searched: { type: 'boolean' },
    nugget: { type: 'string' },
    wrote: { type: 'boolean' },
  },
}

const RUBRIC = `七大主題 topic_index：1=骨髓性腫瘤/急性白血病(AML/MDS/MPN/CML/ALL/HSCT/CAR-T) 2=淋巴系統腫瘤(lymphoma/CLL/myeloma) 3=初級止血(platelet/vWF/ITP/TTP) 4=凝血血栓(coag factor/hemophilia/DOAC/thrombophilia/DIC) 5=紅血球貧血(anemia/thalassemia/hemolysis/PNH) 6=輸血醫學 7=兒科血液。`

const SELFCONTAINED = `【最重要規則:卡片必須「自成一體」】Anki 卡片單張獨立複習,看卡的人手上沒有原始題目。
- <b>嚴禁</b>「本例、本題、此例、此題」等無指涉代稱。
- 要提情境,一律把情境<b>具體寫進卡面</b>。
  ✗ 壞:front「本例為何診斷為 AML?」
  ✓ 好:front「AML 病人骨髓 myeloblast 16%(未達 20%)、帶 t(6;9)/DEK::NUP214,為何仍可直接診斷為 AML?」`

const GOLDCARD = `卡片 gold standard(使用者已核可的格式:簡問/簡答/<hr>下補脈絡,自成一體,繁中保留英文專有名詞):
front: "Platelet transfusion refractoriness 要如何用 corrected count increment (CCI) 的「時間點」區分免疫性 (anti-HLA) 與非免疫性 (消耗性)?"
back: "看 1 小時 CCI:免疫性 → 1hr CCI 就偏低 (&lt;7,500);非免疫性 → 1hr CCI 正常 (&gt;7,500)、但 24hr CCI 偏低 (&lt;4,500)。<hr>連續兩次 1hr CCI &lt;5,000–7,500 即定義 refractoriness。非免疫性占 &gt;80%(sepsis 最常見、splenomegaly、fever、DIC、amphotericin B、BMT);免疫性以 HLA alloimmunization 為主。處置:HLA-matched / crossmatch-compatible platelets;預防靠 leukoreduction。"`

const GOLDFOOTER = `footer(enrich_html)gold standard(自成一體、無「本例/本題」、緻密有數值與例外、機轉→預後→處置因果鏈、附來源年份;標籤後半形冒號):
"<b>📌 考點</b>:ICC 2022 是<b>階層式 (genetics-first) 排他演算法</b>。當 AML 同時帶 t(6;9)/DEK::NUP214 + TP53(VAF 7%) + RUNX1 時,易被 TP53、RUNX1 兩個誘餌誤導;但 <u>t(6;9)/DEK::NUP214 屬 AML-defining recurrent genetic abnormality、優先序最高</u>,直接定案。雙陷阱:TP53 VAF &lt;10%、RUNX1 雖列 MR-gene 但 MR 類需 blast ≥20%(blast 16% 不足)。<br><b>🏥 臨床意義</b>:t(6;9)/DEK::NUP214 高度合併 FLT3-ITD、化療差,屬 ELN 2022 adverse risk → CR1 即規劃 allogeneic HSCT。<br><b>⭐ High-yield</b>:RGA 只需 blast ≥10%(例外:BCR::ABL1 仍需 ≥20%)｜TP53-mutated 需 VAF ≥10%｜MR/NOS 需 ≥20%。<br><b>🔬 實證</b>:優先序 RGA &gt; TP53-mutated &gt; MR &gt; NOS。(Arber et al., Blood 2022;140:1200)"`

function PROMPT(id) {
  return `你是台灣血液專科 board exam 名師。只處理「一題」:${id}。目標:產出該題的<b>最終卡組(≥10 張、自成一體、無「本例」)＋ 一段 enrich footer</b>,達 gold standard 品質。

步驟:
1. Read /tmp/hema_anki/q/${id}.json (stem、options、answer、現有詳解 explanation_md、tags)。
2. Read /tmp/hema_anki/gen/${id}.json 取 "topic_index"(沿用)與既有 base cards。讀不到 topic 才用 rubric:${RUBRIC}
3. **查證(必做)**:用 WebSearch(先 ToolSearch query "select:WebSearch" 載入)針對本題真正考點搜尋 board-exam high-yield(最新 guideline 門檻/分類、首選治療、關鍵 cutoff、重要 trial、預後分層)。優先權威來源(UpToDate摘要、ASH/NCCN/ESMO、PubMed/PMC、主流綜述)。把最精華濃縮成 nugget(繁中保留英文專有名詞,附來源/年份)。若搜尋無果,searched=false 並以現有詳解與你的專科知識完成,但不得編造數據。
4. **產出 cards 陣列(≥10 張,目標 10–13)**:
   a. 取既有 base cards 逐張<b>改寫為自成一體</b>(見規則),保留知識點、修掉模糊代稱。
   b. <b>補新卡</b>到 ≥10 張:涵蓋機轉、診斷準則/數值 cutoff、首選/次選治療、預後分層、關鍵 distractor 為何錯、易混淆鑑別。每張原子化、可獨立作答。
   c. 形式:Basic{kind:"basic",front,back}(back 第一行短答案,接 "<hr>" 脈絡);列舉/分類用 Cloze{kind:"cloze",text:"...{{c1::}} {{c2::}}...",extra}。繁中保留英文專有名詞。
${SELFCONTAINED}
${GOLDCARD}
5. **enrich_html footer**:4 行(📌 考點 / 🏥 臨床意義 / ⭐ High-yield / 🔬 實證),自成一體、無「本例/本題」、情境寫具體、附來源年份。比照:
${GOLDFOOTER}
6. Write /tmp/hema_anki/final/${id}.json(務必合法 JSON;字串內雙引號用「」或 &quot;;HTML 角括號在內文用 &lt; &gt; &amp;):
{"id":"${id}","topic_index":<1-7>,"searched":<bool>,"nugget":"<可空>","extra_tags":["enriched","<疾病/概念英文標籤…>"],"enrich_html":"<footer,單行用 <br> 分行>","cards":[ {"kind":"basic","front":"...","back":"...<hr>..."}, ... ]}
7. 回傳 summary(id, topic_index, n_cards=cards 數, searched, nugget, wrote=true)。內容放檔案,最終訊息只回 summary。`
}

phase('Plan')
const todoRes = await agent(
  'Read /tmp/hema_anki/ids.json (array of 300 ids). List files in /tmp/hema_anki/final/ (named <id>.json). Return {"todo":[ids without a final/<id>.json]} in the original ids.json order.',
  { schema: TODO_SCHEMA, label: 'plan-todo', phase: 'Plan' }
)
const todo = todoRes.todo
log(`final-seq: ${todo.length} questions to finalize (SEQUENTIAL, one at a time)`)

phase('Finalize')
const done = []
let searched = 0, cards = 0
const BATCH = 12 // concurrency raised toward the runtime cap (~min(16, cpu-2)); each question still its own agent
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH)
  const rs = await parallel(batch.map((id, j) => () =>
    agent(PROMPT(id), { schema: SUMMARY_SCHEMA, label: `${id} (${i + j + 1}/${todo.length})`, phase: 'Finalize' })))
  for (const r of rs) { if (r) { done.push(r); cards += r.n_cards || 0; if (r.searched) searched++ } }
  log(`... ${Math.min(i + BATCH, todo.length)}/${todo.length} done (cards ${cards}, searched ${searched})`)
}
log(`final-seq done: ${done.length}/${todo.length} (total cards ${cards}, searched ${searched})`)
return { finalized: done.length, input: todo.length, total_cards: cards, searched_count: searched, summaries: done }
