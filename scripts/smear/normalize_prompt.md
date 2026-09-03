# 抹片練習 · 術語正規化 prompt(Task A3)

這份文件同時是（a）餵給 subagent 的指示模板，也是（b）這一層正規化方法論的文件記錄。
之後要重跑、擴充新的一批答案（例如加入 Test-5），照這份文件的規則做即可。

## 背景

`scripts/smear/data/raw-answers.json` 是 Task A1 (`parse_answers.py`) 從四份抹片考卷
的官方答案 PDF 機械解析出來的。每一列長這樣：

```json
{"key": "Test-2-ANS.pdf", "n": 9, "raw": "Teardrop RBC", "main": "Teardrop RBC", "alts": [], "half": []}
```

- `key` + `n`：這份答案在哪一份考卷（`Test-1-ANS.pdf` ~ `Test-4-ANS.pdf`）的第幾題，
  用來回溯 provenance（A4 對應 ASH 圖庫、A6 匯入都要靠它）。
- `raw`：官方答案原文（含括號）。
- `main`：括號前的主要答案文字。
- `alts`：括號內、且**沒有**被標記「半對」的候選詞（可能是同義詞、可能是俗名、也可能
  是次要提示文字如 `"Arrow : Pronormoblast"`——這些機械解析出來的東西沒有語意判斷，
  下一步全靠人／subagent 補上）。
- `half`：括號內**明確標記「半對」**（`XXX 半對`）的詞——這是官方自己承認「方向對但
  不夠精確」的答案，直接對應到輸出的 `tier: "half"`，不需要重新判斷。

你的任務：把每一列**機械解析**的答案，轉成一份帶有醫學語意判斷的正規化紀錄。

## 輸出格式

**每一個輸入列（每個 `{key, n}`）輸出一筆紀錄**，格式如下：

```json
{
  "key": "Test-2-ANS.pdf",
  "n": 9,
  "dx_id": "dacrocyte",
  "canonical_long": "dacrocyte",
  "canonical_abbrev": null,
  "topic": "rbc",
  "qtype": "cell",
  "terms": [
    {"text": "dacrocyte",    "tier": "full", "form": "long"},
    {"text": "dacryocyte",   "tier": "full", "form": "long"},
    {"text": "teardrop cell","tier": "lay",  "form": "long"},
    {"text": "tear drop",    "tier": "lay",  "form": "long"}
  ]
}
```

把所有輸出紀錄包成一個 JSON 陣列回傳，陣列長度必須等於輸入的列數（一列輸入 = 一筆輸出，
即使多筆輸出共用同一個 `dx_id` 也沒關係——這是預期行為，合併會在下游做）。

## 欄位定義

### `dx_id`

- 小寫、底線分隔的穩定識別碼，例如 `apl`、`aml_m2`、`teardrop_rbc` 不對——這是細胞形態
  不是診斷；細胞類的 `dx_id` 直接用細胞名，例如 `dacrocyte`、`smudge_cell`、
  `hypersegmented_pmn`。

- **⚠️ 合併規則（最容易做錯的地方）**：
  1. **同一個診斷、不同寫法 → 合併成同一個 `dx_id`。**
     例：`APML`、`APL`、`APML (APL)` 全部是「急性前骨髓球性白血病」，一律合併成
     `dx_id: "apl"`（APL 是比較標準的縮寫，選它當 canonical）。
     `AMoL`/`AML M5` 這種——**注意 AMoL 本身就是 M5**，如果考卷把 `AMoL` 和
     `AML, M5`（或 `AML. M5`）當同一格答案的不同寫法用，可以合併；但如果考卷把它們
     當成**分開的題目**在測「這是哪個 FAB 分型」，就不要合併，各自成立一個 dx（用
     `source_answers` 判斷：只要兩者出現在**不同題**，先假設它們指同一個實體概念、
     合併 dx_id 是安全的，因為 canonical 名稱只是「這格答案該怎麼歸類」，不影響
     `source_answers` 各自保留哪一題）。
  2. **同一個大類、不同亞型 → 保持分開，不要合併。**
     `AML`（未分型）、`AML, M2`、`AML, M4`、`AML, M6`、`AML, M7`、`AML M6`
     （拼寫不同但同一個）是**不同**的 dx_id：`aml_unspecified`、`aml_m2`、
     `aml_m4`、`aml_m6`、`aml_m7`。考卷刻意用 M2/M4/M6/M7 測驗學生認亞型的能力，
     合併成一個 `aml` 會讓下游「抽題比例」統計失真。
     同理 `MDS` vs `RAEB, MDS` 可能該分開（RAEB 是 MDS 的一個亞型／進展階段）——
     除非同一份 `source_answers` 底下這兩種寫法其實是同一題的不同抄法。
  3. **拼寫變體、大小寫、標點差異 → 一律視為同一 dx。**
     `Basophilic stipping` / `Basophilic stippling`（拼字錯誤）、
     `Pseudo pelger-huet anomaly` / `Pseudo-pelger huet anomaly`、
     `AML. M5` / `AML, M5`、`Dwarf mega.` / `dwarf megakaryocyte` →
     都合併成同一個 dx_id。
  4. **無法判斷時，寧可分開，不要亂猜合併**——分開的代價是下游多幾個小類，
     錯誤合併的代價是把兩個不同疾病的教學內容混在一起。

### `canonical_long` / `canonical_abbrev`

- `canonical_long`：這個 dx 的完整拼寫名稱（不可為 null）。
- `canonical_abbrev`：這個 dx 公認的縮寫，**沒有就是 `null`，不要硬造**。
  - 有縮寫的例子：AML、MDS、CML、MM、IDA、ATLL、APL、ALL、CLL、ET、WM、LPL、HLH、
    MAHA、DIC、PMN、LGL、PLL、MZL、CMMoL。
  - 沒有縮寫、`canonical_abbrev` 該是 `null` 的例子：`Mitosis`、`Basophil`、
    `Malaria`、`Osteoblast`、`Osteoclast`、`Rouleau formation`、`Target cell`、
    `Toxic granule`、`Howell-Jolly bodies`、`Pappenheimer bodies`、
    `Cabot Ring`、`Döhle body`。

### `topic`（必須是這 7 個值之一，不可自創）

`myeloid` / `lymphoid` / `normal_reactive` / `rbc` / `platelet` / `infection` / `other`

判斷準則：
- `myeloid`：骨髓性腫瘤/白血病細胞系列（AML 各亞型、CML、MDS、CMMoL、APL、
  骨髓性前驅細胞如 promyelocyte/myeloblast，也包括這些細胞的異常型態如
  Auer rod、dysplastic megakaryocyte、hypersegmented PMN、toxic granule、
  Döhle body、Pseudo-Pelger-Huët——這些是骨髓性疾病的形態學表現）。
- `lymphoid`：淋巴性腫瘤/白血病/淋巴瘤（ALL、CLL、mantle cell lymphoma、
  Burkitt lymphoma、hairy cell leukemia、ATLL、PLL、MZL、WM/LPL、
  plasma cell 相關如 MM、plasmablast、Sezary cell、LGL lymphocytosis）。
- `normal_reactive`：正常血球或良性反應性變化，非腫瘤（monocyte、eosinophil、
  basophil、atypical lymphocyte、reactive lymphocyte、mitosis、osteoblast、
  osteoclast、正常紅血球前驅細胞如 pronormoblast/polychromatophilic normoblast，
  除非題目脈絡明確是某個腫瘤的一部分）。
- `rbc`：紅血球形態異常、溶血、貧血相關（thalassemia、IDA、pernicious/megaloblastic
  anemia、spherocytosis、teardrop cell、target cell、burr cell、Howell-Jolly、
  Pappenheimer、Cabot ring、basophilic stippling、rouleau formation、
  cold agglutination、MAHA、acanthocytosis、polychromasia、reticulocyte、
  nucleated RBC、iron overload）。
- `platelet`：血小板數量/型態異常（giant platelet、Bernard-Soulier、
  May-Hegglin、platelet aggregates、dwarf megakaryocyte——但若題目在問
  megakaryocyte 本身的骨髓性腫瘤脈絡，仍可能歸 `myeloid`，用你的判斷）。
- `infection`：感染相關（malaria、candidiasis/fungal infection、
  infectious mononucleosis／IM 的病毒感染本身；但 IM 引起的
  atypical lymphocyte 型態題，若題目問的是「這是什麼細胞」用 `normal_reactive`
  或 `lymphoid` 亦可，用你的判斷；HLH／hemophagocytosis 常由感染誘發但本質是
  巨噬細胞噬血現象，歸 `other`）。
- `other`：組織球/巨噬細胞疾病（histiocyte、macrophage、hemophagocytosis、
  HLH、Gaucher disease、Niemann-Pick disease）、轉移性癌症（metastatic
  cancer / cancer nests）、漿細胞異常但非腫瘤（paraprotein、necrobiosis）、
  以及任何不屬於上述 6 類的答案。

### `qtype`

- `cell`：題目在問「這是什麼細胞／型態」（形態學辨識），例如 blast、promyelocyte、
  teardrop cell、Howell-Jolly body、smudge cell。
- `disease`：題目在問「這是什麼疾病／診斷」，例如 AML、CML、thalassemia、
  hairy cell leukemia、malaria。
- 判斷依據：答案本身是不是一個獨立的細胞/構造名稱（→ `cell`），還是一個臨床診斷
  實體（→ `disease`）。有些答案兩者都沾一點（例如 `CML blast phase`、
  `CML acute blast phase`）——這種診斷式描述仍算 `disease`。

### `terms[].tier`

- `full`（1 分，正確術語）：教科書正式名稱、公認的同義詞、公認的縮寫全稱互換
  （例如 `dacrocyte` / `dacryocyte` 兩種拼法都是 `full`，`AML` 與
  `acute myeloid leukemia` 互為 `full`）。
- `half`（0.5 分，方向對但不夠精確）：**這一層直接沿用輸入列的 `half` 欄位**，
  不要自己重新判斷或增刪——Task A1 已經從官方答案的「XXX 半對」標記精確抽出。
  把 `half` 陣列裡的每個字串各自轉成一筆 `{"text": ..., "tier": "half", "form": ...}`。
- `lay`（0 分，看得懂但是俗名/非正式說法）：**這是本任務最重要、也最容易被
  subagent 偷懶漏掉的一層。** 只要一個詞是「一般人／學生口語會用，但不是教科書
  正式病理學術語」，就標 `lay`，不要因為它「聽起來也對」就丟進 `full`。
  常見俗名例子（不窮舉，用你的血液病理學知識類推）：
  - `tear drop` / `teardrop cell` / `tear drop cell`（正式：dacrocyte/dacryocyte）
  - `burr cell`（在描述 echinocyte／crenated RBC 時是俗名；但若答案本身就寫
    `Burr cell` 且沒有更正式的替代詞在考卷裡出現，仍要在 terms 補一個 `full`
    的正式對應詞如 `echinocyte`，並把 `burr cell` 標為 `lay`）
  - `bite cell`（正式脈絡：G6PD deficiency 造成的 Heinz body 移除後型態，
    `bite cell` 本身其實是病理學界廣泛接受的形態學名詞，可視為 `full`；
    但更口語的講法如「咬一口的細胞」才算 `lay` ——這裡请用你的判斷，
    `bite cell` 傾向 `full`）
  - `smudge cell`（CLL 的破碎淋巴球，這也是廣泛使用的正式病理學用語，可視為
    `full`；但如果同時出現更正式的 `basket cell` 或描述性用語，可以把後者列
    `full`、前者仍列 `full`——`smudge cell` 已經是公認術語不是俗名，除非你判斷
    這個 chunk 的脈絡明確要求更嚴格區分）
  - `target cell`（`codocyte` 的俗名，`target cell` 本身也廣泛用於臨床，
    但正式病理學名詞是 `codocyte`——把 `codocyte` 標 `full`、`target cell` 可視
    情況標 `full` 或 `lay`，若你要收斂，建議 `target cell` 標 `lay`、
    `codocyte` 標 `full`）
  - `hairy cell`（正式：hairy cell leukemia 的 hairy cell 本身也是公認形態學名詞，
    通常標 `full`）
  - `Rouleau formation` 本身是正式術語，不是俗名。
  - `blast` 單獨作為「未分化的芽細胞」籠統俗稱，若考卷本身就只給 `Blast` 這個答案
    （沒有更精確的 myeloblast/lymphoblast 分型），`blast` 本身就是這題的 `dx_id`
    與 `canonical_long`，仍標 `full`（因為它是題目要求的精確答案，不是簡化）；
    但如果同一個 dx 底下有更精確的別名（如 `AML, myeloblast` 這題答案已明確是
    myeloblast），可以把口語的 `blast cell`（沒有分型）額外列為 `lay` 補充詞。
  - 整體原則：**判斷「這個詞是不是教科書／病理報告會直接寫的字」**——會寫
    → `full`；學生私底下口語互稱、患者衛教用語、簡化說法 → `lay`。
  ⚠️ **最終健檢**：如果整批輸出裡「完全沒有任何 `lay` 詞」的比例超過 90%，
  代表你太保守了，回頭把上面列的常見俗名（tear drop、burr cell、smudge cell、
  target cell、bite cell、hairy cell、rouleau 等，只要出現在你這個 chunk 裡）
  重新檢查有沒有漏標。

### `terms[].form`

- `long`：完整拼寫（預設值，大多數詞都是這個）。
- `abbrev`：真正的縮寫/字頭語（AML、MDS、CML、MM、IDA、ATLL、APL、ALL、CLL、
  ET、WM、LPL、HLH、MAHA、DIC、LGL、PLL、MZL、CMMoL、AMoL、AMMoL、G6PD）。
  凡是 `form: "abbrev"` 的詞，該 dx 的 `canonical_abbrev` 也要填上對應值
  （挑最常見/最標準的那個縮寫填入 `canonical_abbrev`，其餘縮寫變體仍可以
  額外列在 `terms` 裡，一樣 `form: "abbrev"`、`tier` 視情況是 `full` 還是
  拼寫變體重複詞）。

## 如何運用輸入列既有的 `main` / `alts` / `half`

- `main` 是強起點：通常直接對應 `canonical_long`（除非 `main` 本身是縮寫，
  這時候 `canonical_long` 該填全名、`main` 的文字進 terms 標 `form: "abbrev"`）。
- `alts` 是候選詞，但**未經語意分類**——Task A1 的機械解析只是把「括號裡、且沒被
  標半對」的文字都丟進 `alts`，不代表它們都是同義詞。你需要逐一判斷：
  - 是真正的同義詞／縮寫全稱 → 進 `terms`，`tier: "full"`。
  - 是俗名 → 進 `terms`，`tier: "lay"`。
  - 是提示性文字而非答案本身，例如 `"Arrow : Pronormoblast"`、
    `"with BM involvement"` → **不要**把整段文字塞進 `terms` 當作可接受的答案；
    改成從中萃取出真正的診斷/細胞名詞（`Pronormoblast`）作為判斷 `dx_id`/`terms`
    的依據，捨棄純粹描述性的部分（`Arrow :`、`with BM involvement` 這類）。
  - 是同一個答案的另一個獨立診斷（例如一格答案裡有兩個小題 `A = ... ; B = ...`）
    → 這種列請你標記成一個較籠統的 dx（例如以主要診斷為主），並在
    `canonical_long` 裡誠實反映內容是複合答案；不需要拆成兩筆輸出（維持
    「一個輸入列一筆輸出」的規則）。
- `half` **直接沿用**，不要重新判斷要不要半對——但你仍要判斷 `half` 裡的詞的
  `form`（long/abbrev）。
- 即使 `alts` 是空的，你也應該視情況主動補上你知道的公認同義詞/縮寫全稱/常見俗名
  （例如 `raw` 只有 `"AML"` 時，補上 `"acute myeloid leukemia"` 作為
  `full`/`long` 的 term）——這是本任務要求你貢獻的部分，不是照抄輸入。

## 三個警告（任務原文，務必遵守）

1. **`dx_id` 要合併同義題**——`AML`、`AML, M2`、`AML, M4` 是不同的 dx（考卷分得出來），
   但 `APML` 與 `APL` 是同一個。合併錯的症狀是抽題比例算錯。
2. **俗名（`lay`）要真的標出來**，不要圖省事全丟 `full`。這一層是整個功能跟
   「隨便一個填空題」的差別。
3. **`canonical_abbrev` 沒有就是 `null`**，不要硬造（`Mitosis` 沒有縮寫）。

## 輸出檢查清單（送出前自己過一遍）

- [ ] 輸出陣列長度 = 輸入陣列長度，每筆都帶 `key` + `n`（原封不動抄過去，方便下游對照）。
- [ ] 每筆 `dx_id` 都是小寫底線格式，沒有空格/大寫/標點。
- [ ] `topic` 只能是 7 個固定值之一，拼字完全一致（不要 `myeloid_neoplasm` 這種變體）。
- [ ] `canonical_abbrev` 沒把握就填 `null`，不要亂猜。
- [ ] 至少檢查過整批裡有沒有明顯俗名被漏標成 `full`。
- [ ] `terms` 不要塞進純描述性文字（如 `"Arrow : Pronormoblast"` 整句），只留術語本身。
- [ ] AML/ALL 各亞型（M2/M3/M4/M5/M6/M7/L1/L2/L3）保持各自獨立的 `dx_id`，不要合併成一個籠統的 `aml`/`all`。

## 你會收到的輸入

一段 JSON 陣列，每個元素是 `{key, n, raw, main, alts, half}`（如上所述）。
請直接針對這份陣列裡的每一筆輸出對應的正規化紀錄，回傳一個 JSON 陣列（純 JSON，
不要加註解或 markdown 圍籬，方便下游程式直接 `json.loads`）。
