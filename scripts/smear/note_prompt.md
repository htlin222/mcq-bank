# 抹片練習 · 詳解初稿 prompt(Task A5)

這份文件同時是（a）餵給 subagent 的指示模板，也是（b）「怎麼寫抹片詳解」這一層
方法論的文件記錄。跟 `scripts/smear/normalize_prompt.md`（Task A3，術語正規化）
是同一種文件——之後要重寫、擴充新診斷的詳解，照這份文件的規則做即可。

## 背景

`scripts/smear/data/dx.json` 有 103 筆診斷紀錄（Task A3 產出），每筆帶
`dx_id` / `canonical_long` / `canonical_abbrev` / `topic` / `qtype` / `terms[]`。

這一步（Task A5）要替**每一個 `dx_id`** 寫一份詳解，掛在 `smear_dx`（詳解是「這個
診斷／型態」共通的教學內容，不是某一張特定圖片的內容——特定圖片的箭頭與 A/B
標註是另一個任務 `smear_questions.image_note` 的事，這裡不寫）。

## 詳解的價值：寫「怎麼判讀」，不是寫「答案是什麼」

⚠️ 詳解的價值不在告訴你答案，答案上一秒才剛揭曉過。它要回答的是**「下次看到一張
沒看過的片，我怎麼走到這個答案」**——所以是固定骨架的判讀流程，不是一段自由散文。
自由散文的問題是每個人寫的角度都不一樣，一百份詳解看下來學不到共通的流程。

## 固定骨架（五段，順序固定）

| 段 | 內容 |
| --- | --- |
| **一句話** | 這是什麼（定義，不含判讀）。一到兩句話，講清楚這個名詞在指涉什麼實體（細胞/型態/疾病），不要在這裡就開始教怎麼認。 |
| **怎麼認** | 判讀流程（見下面依 qtype 分流的模板）。 |
| **容易混淆的** | 跟哪一個像、**差在哪一點**。這一段最重要——考卷上錯的多半不是「完全不會」，是「認成隔壁那個」。**提到別的診斷時要輸出對方的 `dx_id`**（見下方「跨診斷連結」）。 |
| **臨床脈絡** | 什麼情境會看到、看到之後下一步做什麼（例如要不要加做什麼檢查、要不要通報臨床）。 |
| **拼字提醒** | 常見錯拼、以及俗名 vs 正式術語的對照（例如 `tear drop` → `dacrocyte`）。這裡可以直接引用 `dx.json` 裡這個 dx 的 `terms[]`（尤其是 `tier: "lay"` 的那些），因為那正是「別人會誤寫成什麼」的既有資料。 |

## 「怎麼認」的判讀流程模板（依 qtype 與細胞本身有沒有核來選）

⚠️ **決定用哪一種流程,看的是「這個東西本身有沒有核」,不是看 `topic` 欄位。**
`topic` 只是教學分類（rbc/myeloid/lymphoid/...），有些紅系或巨核系的**前驅細胞**
（例如 `pronormoblast`、`multinucleated_erythroblast`、`ring_sideroblast`、
`nucleated_rbc`、`megakaryocyte` 系列）雖然 `topic` 標的是 `rbc` 或 `platelet`，
但它們本身是**有核**的細胞，核的形態才是鑑別的關鍵，所以仍然走「細胞題」的白血球
系流程，不要因為 `topic: rbc` 就套用紅血球流程。

### 1. 細胞題,且該細胞有核(qtype=cell,涵蓋白血球系、紅系前驅細胞、巨核系前驅細胞)

固定走五個軸,依序低倍→高倍→決定性特徵:

1. **大小**(跟同一張抹片上的紅血球/成熟淋巴球比,大概幾倍)
2. **核質比**(N:C ratio——原始細胞高、成熟細胞低,這是分辨「幼稚 vs 成熟」最快的一眼)
3. **核形與染色質**(圓形/凹陷/分葉/摺疊;染色質細緻鬆散 vs 粗糙濃縮)
4. **核仁**(看不看得到、幾個、明不明顯——原始細胞通常有,成熟細胞通常沒有)
5. **胞質顆粒與嗜鹼性**(顆粒的顏色/大小/有沒有 Auer rod 這類異常構造;胞質嗜鹼性
   deep blue vs 淡染)

寫作時每一軸給一句具體描述,不要五個軸都寫「正常」這種空話——如果某一軸不是這個
診斷的鑑別重點,可以一句話帶過,但不要整段省略(讀者需要知道「這一軸我看過了,
沒有特別的」也是一種資訊)。

### 2. 細胞題,且是成熟無核紅血球型態(qtype=cell, topic=rbc 的成熟紅血球形狀/內含物異常)

適用對象:紅血球的形狀改變(如 acanthocyte、echinocyte、codocyte、dacrocyte)、
內含物(如 Howell-Jolly body、Pappenheimer body、Cabot ring、basophilic
stippling)、排列方式(如 rouleau formation)——這些都是**沒有核**的成熟紅血球。

固定走五個軸:

1. **形狀**(圓形/棘狀/淚滴狀/靶狀/新月狀...)
2. **大小**(正常/偏大 macrocytic/偏小 microcytic,跟旁邊正常紅血球比)
3. **中央淡染區**(central pallor——擴大、消失、還是正常;這是判斷是否為
   spherocyte/target cell 一類的關鍵)
4. **內含物**(有沒有 Howell-Jolly body、Pappenheimer body、Cabot ring、
   basophilic stippling、瘧原蟲之類的東西長在細胞裡)
5. **分佈**(單顆散在、成串排列如 rouleau、成堆凝集如 cold agglutination——這是
   在低倍視野一眼就看得出的線索,常常是第一個該注意的)

### 2b. 細胞題,且是無核血小板型態(qtype=cell, topic=platelet 的成熟血小板異常)

適用對象:`giant_platelet`、`platelet_aggregates` 這類沒有核的血小板本身型態異常
(巨核系的**有核**前驅細胞,如 megakaryocyte/promegakaryocyte/dwarf megakaryocyte/
dysplastic megakaryocyte,仍走上面「細胞題,有核」流程)。

比照紅血球流程但把「中央淡染區」換成「顆粒密度」:

1. **形狀**(圓盤狀/不規則突起)
2. **大小**(跟紅血球比——giant platelet 常常跟紅血球一樣大甚至更大)
3. **顆粒密度**(alpha/dense granule 看得到的量,gray platelet 一類會顆粒稀疏,
   本題庫沒有但寫作時留意這個軸的可延伸性)
4. **內含物/聚集狀態**(是不是黏成一團——platelet aggregates 的重點就在這裡,
   而不是單顆血小板的形態)
5. **分佈**(是不是在抹片邊緣或血塊附近才看到聚集——這牽涉到採檢/抹片品質的判斷)

### 3. 疾病題(qtype=disease)

固定走三步,由粗到細:

1. **哪一群細胞異常**(骨髓性?淋巴性?紅系?巨核系?還是多系都受影響?)
2. **異常在哪一個成熟階段**(原始細胞為主、還是某個中間分化階段的細胞增多、還是
   成熟細胞的型態/數量異常?這一步決定了「這是急性/慢性/增生性/發育不良性」)
3. **有沒有伴隨的背景變化**(白血球分類計數的其他線索、有沒有 leukoerythroblastic
   reaction、有沒有伴隨貧血/血小板低下、周邊血 vs 骨髓抹片的差異)

## 跨診斷連結:「容易混淆的」段落的兩個輸出

「容易混淆的」這一段在**文字內容**裡直接寫清楚跟哪個診斷像、差在哪一點(用中文
說清楚鑑別點,可以直接寫對方的英文名稱方便閱讀),**同時**在紀錄的
`related_dx_ids` 欄位裡列出文字中提到的**每一個**其他診斷的 `dx_id`——這是給前端
畫 `/smear/dx/<id>` 連結用的結構化欄位,不是裝飾。

- 只列**真的在這 103 個 dx_id 裡存在**的診斷。你會收到全部 103 筆的
  `dx_id → canonical_long` 對照表,連結務必查表確認,不要憑記憶猜一個聽起來對的
  id(例如某個鑑別診斷剛好不在這 103 筆裡,那就只在文字裡提名字、不要塞進
  `related_dx_ids`)。
- 一個 dx 可以有 0 個、1 個或多個 `related_dx_ids`。真的找不到值得比較的對象時
  (少數,例如非常獨特的型態)寫 0 個沒關係,不要硬湊。
- 不要把自己的 `dx_id` 放進自己的 `related_dx_ids`。
- 這一段是全篇**最重要**的段落,考卷上答錯的多半是「認成隔壁那個」——花心力在
  這裡,不要寫成「跟 XX 不同」這種沒有比較點的空話,一定要講出**差在哪一個具體
  可觀察的特徵**(大小?核形?顆粒?染色質?臨床情境?)。

## 輸出格式:TipTap JSON + 結構化欄位

每個 dx_id 輸出一筆紀錄:

```json
{
  "dx_id": "promyelocyte",
  "content_json": {
    "type": "doc",
    "content": [
      {"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": "一句話"}]},
      {"type": "paragraph", "content": [{"type": "text", "text": "..."}]},

      {"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": "怎麼認"}]},
      {"type": "paragraph", "content": [
        {"type": "text", "marks": [{"type": "bold"}], "text": "大小："},
        {"type": "text", "text": "..."}
      ]},
      {"type": "paragraph", "content": [
        {"type": "text", "marks": [{"type": "bold"}], "text": "核質比："},
        {"type": "text", "text": "..."}
      ]},
      {"type": "paragraph", "content": [
        {"type": "text", "marks": [{"type": "bold"}], "text": "核形與染色質："},
        {"type": "text", "text": "..."}
      ]},
      {"type": "paragraph", "content": [
        {"type": "text", "marks": [{"type": "bold"}], "text": "核仁："},
        {"type": "text", "text": "..."}
      ]},
      {"type": "paragraph", "content": [
        {"type": "text", "marks": [{"type": "bold"}], "text": "胞質顆粒與嗜鹼性："},
        {"type": "text", "text": "..."}
      ]},

      {"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": "容易混淆的"}]},
      {"type": "paragraph", "content": [{"type": "text", "text": "跟 myeloblast 的差別在於……"}]},

      {"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": "臨床脈絡"}]},
      {"type": "paragraph", "content": [{"type": "text", "text": "..."}]},

      {"type": "heading", "attrs": {"level": 3}, "content": [{"type": "text", "text": "拼字提醒"}]},
      {"type": "paragraph", "content": [{"type": "text", "text": "..."}]}
    ]
  },
  "related_dx_ids": ["myeloblast", "abnormal_promyelocyte"]
}
```

- `content_json` 是完整的 TipTap/ProseMirror doc(`doc` 節點包一串
  `heading`(level 3)+ `paragraph`),跟這個 repo 其他地方存 `content_json` 的
  慣例一致(見 CLAUDE.md「Storage: TipTap JSON, not HTML」那節)——**不要**輸出
  HTML 字串,`content_json` 必須是可以直接 `JSON.parse` 進 TipTap 的合法文件節點。
- 「怎麼認」段允許多個 `paragraph`(每個判讀軸一段,用 `bold` mark 標軸名再接內容,
  如上例),其他四段通常一段 `paragraph` 就夠,內容較長時也可以拆成多段——不強制
  單段,但**標題(`heading` level 3)一定要是這五個字串,完全比照上表,不要意譯或
  加字**:`一句話` / `怎麼認` / `容易混淆的` / `臨床脈絡` / `拼字提醒`。
- `related_dx_ids`:字串陣列,每個元素是一個**存在於 103 筆 dx 清單裡**的
  `dx_id`。沒有要連結的診斷就給空陣列 `[]`,不要省略這個欄位。
- 純文字內容,不要用 TipTap 的 `mention`/自訂連結節點——連結的產生留給下游拿
  `related_dx_ids` 去組 `/smear/dx/<id>`,詳解本文只需要負責講清楚鑑別點。

## 醫學正確性是硬要求

這些詳解會直接給準備專科考試的學生讀。**用你真正的血液病理學知識寫,不要為了
填滿骨架而寫空泛的話**,尤其是:

- 「容易混淆的」的鑑別點要是真的、可觀察的形態學差異或真的存在的臨床區分點,
  不是「兩者不同」這種空話。
- 「臨床脈絡」要講真實會遇到的情境(什麼病人、什麼檢驗會先發現、發現後臨床上
  下一步通常做什麼),不要編造不存在的處置建議。
- 縮寫、FAB 分型、WHO 分類用語要正確;不確定某個細節時,選擇保守、教科書上有
  共識的講法,不要杜撰數字或百分比。

## 你會收到的輸入

1. 一份 JSON 陣列,是你這個 chunk 要處理的 dx 完整紀錄(`dx_id` /
   `canonical_long` / `canonical_abbrev` / `topic` / `qtype` / `terms[]`)。
2. 一份**全部 103 筆**的 `dx_id → canonical_long`(含 `canonical_abbrev` /
   `topic` / `qtype`)對照表,用來在「容易混淆的」段落裡正確地填
   `related_dx_ids`(對方可能不在你這個 chunk 裡,但只要存在於這份對照表,就可以
   連結)。

請針對你 chunk 裡的**每一筆** dx 輸出一筆對應的詳解紀錄,包成一個 JSON 陣列,
陣列長度必須等於你收到的 chunk 筆數。純 JSON,不要加註解或 markdown 圍籬,方便
下游程式直接 `json.loads`。

## 輸出檢查清單(送出前自己過一遍)

- [ ] 輸出陣列長度 = 收到的 chunk 筆數,每一筆的 `dx_id` 跟輸入一一對應。
- [ ] 每筆 `content_json` 都是合法的 TipTap doc(`type: "doc"`,`content` 是
      `heading`/`paragraph` 陣列),五個標題字串完全比照骨架,順序固定。
- [ ] 「怎麼認」段確實依 qtype 與細胞有沒有核選對了流程模板(白血球系五軸 /
      紅血球五軸 / 血小板五軸 / 疾病三步),不是每筆都套用同一套。
- [ ] 「容易混淆的」段落裡提到的每個其他診斷,都在 `related_dx_ids` 裡有對應的
      `dx_id`,而且那個 `dx_id` 真的在全部 103 筆的對照表裡。
- [ ] 沒有把自己的 `dx_id` 放進自己的 `related_dx_ids`。
- [ ] 醫學內容具體、正確,沒有空泛套話,沒有杜撰的數字或分類。
