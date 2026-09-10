# 跑台模組(smear station)設計

日期:2026-09-09。前置閱讀:`docs/smear-overview.md`(模組總覽)、
`docs/plans/2026-09-03-smear-practice-design.md`(抹片練習原始設計)。

## §0 這份文件回答的問題

學長的回饋原話裡有兩句話,長得像同一件事,其實是兩件:

> 「有辦法有一個『跑台模組』,就不是單一一張圖就下診斷,而是 PB smear、BM,低倍到高倍
> 來看一個病人」

> 「就算是同一種疾病,也可以多看不同病人的片子,因為彼此都還是會有些許差異。例如同樣
> 是 APL,我看過的病人 morphology 都長不太一樣」

**第一句要新的資料模型與新內容;第二句不需要,素材早就在資料庫裡了。**
把兩句話當成一件事做,會得到一個又大又晚的東西,而其中真正每天會被用到的那一半
(第二句)本來一個下午就能上。所以這份設計把它們拆成兩條線,而且第二條先上。

## §1 量到的事實

規劃前實際查過的數字,每一個都推翻了一個直覺:

| 量的東西 | 結果 | 推翻了什麼 |
| --- | --- | --- |
| ASH `reference-cases` | 137 案、1111 張圖、中位數約 6 張 | 「多病人多張圖的素材要自己拍」 |
| ASH 案例落在幾個 WHO 葉節點 | 134 案 → 114 個葉節點,只有 17 個有 2 案以上 | 「案例庫可以拿來反覆刷」 |
| ASH 逐張 metadata | 只有檔名式 alt(`AML-with-t8-21--5`),無模態、無倍率、無順序 | 「匯進來就能用」 |
| ASH 案例敘述 | 是通用疾病描述,不是逐張所見 | 「揭曉文字現成」 |
| 現有 `smear_dx` 的 CLL | 只有 `cll_and_infectious_mononucleosis`,正解字串是雙欄投影片的 `A: CLL…; B: IM…` | 「ALL vs CLL 只要出題就好」 |
| 現有 `smear_dx` 的 PLL | 只有一個 `pll`,沒有 T/B 之分 | 同上 |
| 單張題每個 dx 幾張圖 | 2 到 10 張,眾數 4 張(37 個 dx) | 「同一診斷多版本要新素材」 |
| Dropbox `抹片考訊/` | 已匯入的 203 題來自 pre-test-A-2026 / week12 / wk-11-test / pre-test-2 | — |
| 同資料夾的 Smear-1..5 | **從未匯入**,共 194 頁 | 「素材已經吃乾淨了」 |
| Smear-1 + Smear-5 切出的案例 | 16 案、77 個帶圖頁、159 張圖 | 「量太少不值得做」 |
| 帶日期的圖說 | 61 個,其中 **24 個(39%)冒號後面直接寫了判讀** | 「圖說可以揭曉前顯示」 |
| Smear-2/3/4 帶日期的圖說 | 各 1 個 | 「五份都是案例」 |

最後一列是這輪最重要的發現,見 §2。

## §2 內容來源:和信教學片才是這個模組的主素材

`~/Dropbox/血專大補丁/抹片考訊/` 底下的 `20250313_血液_Smear-1.pdf` 到
`20250702_血液_Smear-5.pdf`,是和信醫院血液腫瘤科徐千富醫師的「Hema Learning Hub」
教學系列,五堂課 194 頁,**從來沒有進過匯入管線**。

它同時命中學長回饋裡的每一句:

- **Lesson 5 整份就叫 Challenging cases**,八案的標題是
  `Case 3: ALL vs. FL?`、`Case 4: CLL vs. Reactive?`、`Case 7: AML vs. Aggressive BCL?`、
  `Case 8: AML vs. LPL?`。學長說「實務上光是 ALL 和 CLL 有時候就有點難分」,
  這份教材整堂課在講的就是這個。Lesson 1 也是 Case 1–8 的結構。
- **Smear-3 有 T-PLL 與 B-PLL**(Smear-2 也有 B-PLL),帶臨床特徵與免疫表型。
  學長說「邱醫師說的 T-PLL 或者其實也有 B-PLL,我印象中和信的教學片有」—— 就是這幾份。
- **Lesson 5 Case 6 是 APL (pancytopenia)**,對得上學長講的 hypogranular APL 那個跑台題。
- **每案帶完整臨床病史**:年齡、性別、主訴、CBC 分類、生化、影像。跑台考的是綜合實力,
  而 ASH 那 134 案**沒有病史**,只有一段疾病教科書描述。

而且它把最貴的那個問題解掉了:

> **投影片自己標了模態。** 頁面上寫著 `2025/04/09 Peripheral blood` 與
> `2025/04/10 Bone marrow`,`Pleural effusion`、`Mass aspiration` 也一樣。
> 逐張的 PB/BM 標註**從投影片文字抽得出來,不需要視覺模型**。

**授權已確認可用**(2026-09-09)。站台在 Cloudflare Access 後面、20 個內部使用者、
非商業,既有的 203 題也是同一個資料夾的考訊。`smear_cases.attribution` 仍要填,
出處寫到 deck 與課次。

### §2.1 v1 的 20 個核心案例

| 來源 | 案數 | 覆蓋 |
| --- | --- | --- |
| Smear-5 全收 | 8 | B-ALL、T-ALL、`ALL vs. FL?`、`CLL vs. Reactive?`、Pancreatic ca with HLH、APL、`AML vs. Aggressive BCL?`、`AML vs. LPL?` |
| Smear-1 選 4 | 4 | Burkitt with BM involvement、Ewing sarcoma 骨髓轉移、Leukocytosis with ecchymosis、HLH(取 13 個帶圖頁那案) |
| ASH 選 8 | 8 | `#138` MDS del(5q)、`#102` HCL、`#129` MCL、`#142` CLL atypical、`#73` PV、`#16` ET、`#144` HbSD、`#11` AA + PNH |

- **Smear-1 只取 4 案。** 八案裡有三案是 HLH,而且標題是臨床描述(`Intermittent HLH
  for 5 months`)不是鑑別診斷。留最完整的那一案,其餘兩案的圖進單張題池。
- **`#142 CLL with atypical features` 是刻意選的。** 它跟 Smear-5 的 `CLL vs. Reactive?`
  是**同一個診斷的兩個病人**,在案例層面兌現學長那句「同樣的病,不同病人長得不一樣」。
  這也是 §3 第三條「共用 `smear_dx`」買到的東西 —— 另開一套詞彙的話這兩案串不起來。
- **CML 與 MM 沒有案例,只有單張題。** 兩者在跑台常入題,但 ASH 沒有堪用的案例,
  而和信兩份也沒有。這是 v1 已知的洞,寫在這裡是為了不要有人以為漏掉了。

**第二個來源:Alberta 的開放教科書。**
[A Laboratory Guide to Clinical Hematology](https://pressbooks.openeducationalberta.ca/mlsci/)
(Villatoro & To,CC BY-NC)是 RBC 形態為主的圖譜。原設計把 PathologyOutlines 補圖
延後的理由是「對 RBC 形態幾乎沒覆蓋」,這本書正好補那個洞。CC BY-NC 要求標示出處,
`smear_questions` 已經有 `attribution` 與 `source_url` 兩個欄位。
**它補的是單張題的覆蓋率,不是跑台** —— 圖譜是單細胞圖,不是病人。

**ASH 選 8 案進 v1,其餘 126 案留 v2。** ⚠️ 這一段是 2026-09-09 改過的,而**改的理由
是原本的判斷被量測推翻**:第一版寫著「ASH 沒有病史」,那是只讀了一案(AML t(8;21),
剛好是唯一一種通用疾病描述)就下的結論。實際數過 134 案的敘述:

| | 案數 | 比例 |
| --- | --- | --- |
| 有年齡或主訴 | 107 | 79% |
| 有實驗室數值 | 34 | 25% |
| 兩者都有 | 28 | 20% |

**下次要否決一個資料來源,先數過再說。** 一案的樣本推不出 134 案的結論。

剩下的真差別只有一個:**ASH 沒有逐張說明,只有整案敘述。** 這個落差的處理見 §3 第二條
—— 兩種來源都改成中途不回饋,格式就一致了。

⚠️ **ASH 補得上,但補不齊。** `reference-cases` 裡 **T-PLL、B-PLL、CMML、
myelofibrosis、MAHA、malaria、ATLL、Burkitt 一案都沒有**;CML 與 MM 有候選但不帶病史
或圖太少。學長點名的 T-PLL / B-PLL 因此**留在單張題**,素材是 Smear-3(帶臨床特徵與
免疫表型)。不要再回頭去 ASH 找這幾個。

## §3 七個已決定的事

每一條都是從被否決的選項裡挑出來的,理由寫在右欄。**下一輪不要重新提議右欄的東西。**

| 決定 | 被否決的 | 為什麼 |
| --- | --- | --- |
| **逐步揭露,中途要答**:一次一張,答完才解鎖下一張,最後一張才問診斷 | 全部攤開只問診斷 / 只做瀏覽 | 跑台測的是「看到什麼就想到什麼」的過程,一次攤開等於把過程跳過 |
| **中途完全不回饋**:寫下就進下一張,揭曉時才逐張並排「你寫的」與「原文」 | 關鍵詞命中計分 / 勾選清單 / 改問封閉問題 / 每張送出後立刻給說明 | 形態描述沒有封閉答案集;關鍵詞命中的偽陰性會讓模組一直判你錯。勾選清單本身洩題(看到 Auer rod 在選項裡就不用猜了)。**「每張立刻給說明」是 2026-09-09 改掉的**:ASH 案例沒有逐張原文,兩種來源會變成兩種節奏;而且真的跑台本來就不會看一張就有人告訴你對不對 |
| **正解共用 `smear_dx`**,缺的詞彙補進去 | case 另開一套答案詞彙 / dx 加旗標分流 | 一個病人就是那個診斷的一個實例,跟一張圖同地位。另開一套的話「CLL 案例」跟「CLL 單張圖」會變成兩個互不相干的東西,而那正好殺掉「同一診斷多版本」 |
| **只標模態,揭曉文字用原文** | 逐張自產形態描述 | 103 份 dx 詳解過了兩輪醫學審核才上線;1111 段逐張描述只抽樣審,等於接受「有幾段是錯的,不知道哪幾段」。而和信投影片的模態標籤與說明文字本來就在頁面上 |
| **`/smear/station` 自己一條路,不做全真** | 跑台也有計時交卷 / 混進現有 session | 全真的價值建立在交卷前什麼都不揭曉,而跑台的核心迴圈就是「答一張、看一張說明」,兩者直接衝突。也省下把四道防洩閘在案例形狀上重做 |
| **「同一診斷多版本」用抽題輪替**,同 dx 優先給沒作答過的圖 | 揭曉後並排同病其他片子 / dx 頁做片庫格線 / 三個都做 | 落在每天真的在用的那條路上,而且不加表不加內容 —— `smear_answers` 有 `question_id`,「這個人看過哪張」推導得出來 |
| **v1 = 和信 5 份 + Alberta 書** | 只做 ASH / 和信 + ASH / 只做和信 | 見 §2 |

## §4 資料模型

新增兩張內容表、一張使用者表。**`smear_dx` / `smear_terms` / `smear_dx_notes`
一個欄位都不動** —— 這是共用 dx 那條決定買到的東西。

```sql
-- 一個病人。答案就是 dx_id,判定沿用 gradeSmear() 比對 smear_terms。
CREATE TABLE smear_cases (
  id              TEXT PRIMARY KEY,   -- 'kfs-l5-c3' = deck + case 序號
  dx_id           TEXT NOT NULL REFERENCES smear_dx(id) ON DELETE CASCADE,
  history_md      TEXT,               -- 臨床病史:年齡/主訴/CBC/生化,開場就給
  discussion_json TEXT,               -- 揭曉後的討論(TipTap JSON,來源是投影片原文)
  source          TEXT NOT NULL,      -- 'kfs'(和信)| 'ash'(v2)
  source_ref      TEXT,               -- 'Smear-5.pdf#Case3'
  attribution     TEXT,
  created_at      INTEGER NOT NULL
);

-- 一張圖 = 案例的一個步驟。順序由 idx 決定,PB 在前 BM 在後。
CREATE TABLE smear_case_items (
  case_id        TEXT NOT NULL REFERENCES smear_cases(id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,
  modality       TEXT NOT NULL,       -- pb|bm|effusion|aspiration|other
  image_key_view TEXT NOT NULL,
  image_key_full TEXT NOT NULL,
  caption        TEXT,                -- '2025/08/03 BM smear' —— 冒號左半,揭曉前可見
  reveal_note    TEXT,                -- 這一張的原文說明 —— 揭曉後才送
  PRIMARY KEY (case_id, idx)
);

-- 一次跑台 = 一列。不開 session、不計時、不交卷(見 §3 第五條)。
CREATE TABLE smear_case_attempts (
  id          TEXT PRIMARY KEY,
  user_email  TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  case_id     TEXT NOT NULL REFERENCES smear_cases(id) ON DELETE CASCADE,
  notes_json  TEXT,                   -- 逐步的自由輸入,不判分;揭曉時跟原文並排
  final_typed TEXT,
  tier        TEXT,                   -- full|half|lay|miss,gradeSmear() 給的
  score       REAL,
  steps_seen  INTEGER,                -- 看到第幾張才敢下診斷
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_smear_case_attempts_user ON smear_case_attempts(user_email, created_at);
```

四個承重的地方:

- **`smear_cases.id` 不准內嵌 dx slug。** ASH 那批的 `ash-hairy_cell_leukemia-63662`
  原樣送到前端就是洩答(#223),`clientQuestionId()` 就是為它存在的。用 deck + 序號
  從源頭讓這個問題不存在,而不是再加一層防護。
- **沒有 `title` 欄位。** 投影片上的標題是 `Case 3: ALL vs. FL?` —— 它含答案。
  存進來就一定有某一支端點會順手把它送出去。**不存,就沒有這個風險。**
  要在清單上顯示,用 `#3` 或病史的第一句。
- **`caption` 只能存冒號的左半。** 投影片原文是 `2022/08/03 BM smear: suspect AML`,
  61 個帶日期的圖說裡有 24 個(39%)長這樣。左半是日期與模態,是要給的線索;
  右半是判讀,原樣存進 `caption` 就等於把答案印在圖旁邊。**切點在冒號,右半進
  `reveal_note`。** 這一條是量出來的,不是防禦性設計。
- **`reveal_note` 與 `discussion_json` 揭曉前不進 payload。** 這是這個模組唯一的
  洩題面,見 §6。
- **一個步驟是一張投影片頁,不是一張嵌入圖。** `render_pages.py` 本來就是整頁轉 WebP,
  而 159 張嵌入圖分佈在 77 頁上 —— 一頁常常並排 PB 與 BM。所以 `modality` 允許多值,
  並排的那一頁就是一個同時給兩種的步驟,不要為了讓順序好看而去裁圖。
- **`steps_seen` 是這個模組唯一有意義的數字。** 分數答「認不認得」,拼字答
  「寫不寫得出來」(既有兩條),`steps_seen` 答「要看幾張才敢講」—— 那正是跑台在測的。

**`cll_and_infectious_mononucleosis` 不刪、不改。** 它是一張真的雙欄投影片,
正解確實是「A 是 CLL、B 是 IM」,那一列沒有錯。要補的是**另外新增**一個 `cll`
給和信的 CLL 素材用。刪它會經由 `ON DELETE CASCADE` 帶走詳解、收藏、作答紀錄,
而那是為了整齊去動使用者資料。同理 `pll` 保留,另加 `t_pll` / `b_pll`。

## §5 端點與路由

| 端點 | 用途 | 洩題注意 |
| --- | --- | --- |
| `GET /api/smear/cases` | 案例清單:id、`steps` 張數、`modalities`、我答過沒 | 不回 `dx_id`、不回任何說明文字 |
| `GET /api/smear/cases/:id` | 開場:`history_md` + **全部**圖的 key 與清乾淨的 `caption` | 不回 `reveal_note`、不回 `discussion_json` |
| `POST /api/smear/cases/:id/answer` | 送出診斷與逐步筆記 → `gradeSmear()` → 回 tier + 全部 `reveal_note` + `discussion_json` | 這支之前,說明文字一次都不會出現 |

**「中途不回饋」把 `/step` 整支端點消掉了。** 既然每一步不需要伺服器回話,圖就可以
一次全給、由 client 逐張揭開 —— **少一支端點就少一個洩題面**,而且換題不必等 RTT。
洩的是文字不是圖:知道這案有五張圖、其中一張是骨髓,是合理的線索不是答案。

`steps_seen` 由 client 隨最後那支一起回報。它不計分,所以不需要防作弊 —— 同
`play-2048` 那條「驗證只防資料汙染,不防作弊」。

前端路由 `/smear/station`(清單)與 `/smear/station/:id`(作答)。
⚠️ **要排在 `/smear/dx/:id`、`/smear/s/:id` 這兩個萬用參數路由之前**,
`App.tsx` 已經有註解在講這件事。

`/api/smear/cases*` **不進 `sw-guards.ts` 的 `CACHEABLE_API`** —— 同該模組其他每一支。
快取住的症狀是「答過的案例重整之後又變成沒答過」。有測試釘著。

## §6 洩題面只剩一個點,但它比單張題更容易漏

沒有全真模式,所以既有四道閘不必重做。但案例形狀帶進來一個新的:
**揭曉文字的體積大,而且它在同一個元件裡。**

單張題的正解是一個詞,掃描器找那個詞就好。案例的「答案」散在
`reveal_note`(逐張)、`discussion_json`(整案)、以及病史裡可能出現的
`確診為 T-ALL` 這種句子。三者都要在對應的那一步之前不存在於 payload 裡。

守法沿用既有的:**e2e 掃整頁原始碼**,斷言在送出診斷之前,
`smear_terms` 裡屬於這個 dx 的任何一個寫法都掃不到。
並且照既有慣例補一條**自我驗證** —— 故意讓某一支端點提前吐出 `discussion_json`,
掃描要抓得到。沒有這條,掃描器壞掉的時候是全綠的。

⚠️ **病史要人工過一遍。** `Case 2: T-ALL (mediastinal mass)` 的病史裡寫著
「CXR showed mediastinal mass」—— 那是線索不是答案,留著。但同一份投影片裡
出現過「2025/03/19 KFSYSCC: for second opinion」這類句子的旁邊,常常就接著
確診結果。**這一段機器判不出來,匯入時逐案看過**,16 案的量做得到。

## §7 內容管線

```
~/Dropbox/血專大補丁/抹片考訊/Smear-{1..5}.pdf   194 頁
  ├─ render_pages.py     既有:每頁 → trim 白邊 → WebP ×2(view 1600 / full 2400)
  ├─ parse_cases.py      新:抽 `Case N: <dx> (<副標>)` 切案界、抽頁面上的
  │                         `Peripheral blood` / `Bone marrow` 當 modality、
  │                         抽病史段與說明段
  └─ 人工過一遍          16 案,逐案看病史有沒有夾答案(§6)、dx 對不對

pressbooks.openeducationalberta.ca/mlsci   CC BY-NC
  └─ fetch_oer.py        新:逐章抓圖 + 章名 → 對到現有 rbc 主題的 dx,
                             source='oer',attribution 必填
```

- **`normalizeTerm()` 只有一份**,新腳本一樣直接 import `worker/lib/smear-grade.ts`。
  匯入端與判定端各自一份的話,寫進 `norm` 的字串跟比對時算出來的會漂。
**已經量過的**(2026-09-09,直接跑 `pdftotext -layout` 與 `pdfimages -list`):

| | Smear-1 | Smear-5 |
| --- | --- | --- |
| 案數 | 8 | 8 |
| 帶圖頁 | 44 | 33 |
| 每案帶圖頁 | 1 到 13 | 2 到 8 |
| 標題形態 | 臨床情境(`Intermittent HLH for 5 months`) | **鑑別診斷**(`ALL vs. FL?`、`CLL vs. Reactive?`) |

**兩份不一樣,而 Smear-5 才是這個模組要的。** Smear-1 的八案有三案是 HLH,標題是
臨床描述而不是鑑別;Smear-5 的八案標題直接就是「這兩個病要怎麼分」。**先做 Smear-5**,
Smear-1 當第二批。

⚠️ **模態有兩套寫法**:`PB smear` / `BM smear`(Smear-5 的 APL 那案全用這套)與
`Peripheral blood` / `Bone marrow`。只認長寫法的話,APL 那一案會整案標不到模態,
而症狀是「這一案沒有 PB→BM 的順序」,看起來像那一案剛好沒有骨髓片。

⚠️ **案界要有結束錨點,不能只認開頭。** 只找 `Case N:` 的話,最後一案會一路吃到投影片
結尾 —— 實測 Smear-1 的 Case 8 被算成 17 頁,其中 4 頁是收尾投影片。用 Outline 頁的
案數當上界,同 `parse_answers.py` 的錨點題精神。

**APL 那一案的軸是時間,不只是倍率。** `08/01 PB smear: no obvious blast` →
`08/03 BM smear` → `08/05 PB smear: leukemic promyelocyte` → `08/09 PB smear (post-ATRA)`。
第一張看起來沒事,這正是學長講的 hypogranular APL 那種跑台題。所以
`smear_case_items.idx` 排的是**投影片本來的順序**,不要自作聰明按模態重排。

- **`parse_cases.py` 的 dx 對應要靠錨點驗證**,同既有 `parse_answers.py` 的教訓:
  頁數對得上不等於對得對。這裡的錨點是 Lesson 5 的 Outline 頁 —— 它把八個案的
  診斷列成一張表,可以拿來對切出來的案界。
- **上線前 `SELECT COUNT(*) FROM smear_case_items`。** 這個 repo 有前科:
  `lecture_page_questions` 建好了、路由寫好了、前端做好了,而表是空的,幾個月沒人發現。

## §8 前置條件:import 的破壞性

**這一項不做,§7 兩條管線都不能對正式機跑。**
`scripts/smear/import.ts` 是 delete-then-insert,會清掉
`smear_sessions` / `smear_answers` / `smear_term_votes`。

現在的窗口是開的:正式機 3 場 session、**0 場交卷**、1 筆作答。
但這份設計的每一項都要重灌(補 `cll`/`t_pll`/`b_pll`、加案例、加 OER 圖),
而且之後每次修詳解也要,所以趁現在改掉,不要再賭一次。

拆法照 overview §12 已經寫好的:

| 內容表(upsert,可重跑) | 使用者表(絕不碰) |
| --- | --- |
| `smear_dx`、`smear_questions`、`smear_dx_notes`、`smear_fts` | `smear_sessions`、`smear_answers`、`smear_term_votes` |
| `smear_terms` **僅限 `proposed_by IS NULL` 的列** | `smear_notes`、`smear_comments`、`smear_dx_bookmarks`、`smear_submissions` |
| 新增:`smear_cases`、`smear_case_items` | 新增:`smear_case_attempts` |

⚠️ `smear_terms` 那一格是最容易寫錯的:社群提報進來的列(`proposed_by IS NOT NULL`)
要保住,否則一次重灌就把大家投票通過的寫法全部退回原始詞表,
而症狀是「我明明提報通過了,怎麼又算我錯」。

## §9 抽題輪替(第二條線,不依賴上面任何一項)

`worker/lib/smear-pick.ts` 的 `pickSmearSet()` 現在在同一個 dx 底下隨機挑圖。
改成**優先挑這個人沒作答過的**,全部看過才回頭隨機。

```sql
-- 「這個人看過哪些圖」。推導,不加表 —— 同「attempts 是 source of truth」那條。
SELECT a.question_id FROM smear_answers a
JOIN smear_sessions s ON s.id = a.session_id
WHERE s.user_email = ?          -- 綁的變數名字要有 email(bind-order.ts 會掃)
```

- **純函式與查詢要分開。** 挑選邏輯進 `pickUnseenFirst(candidates, seen, rng)`,
  在 `smear-pick.ts` 旁邊寫測試 —— 邊界是「全部看過」「一張都沒看過」「剛好剩一張」。
- **全部看過就回頭隨機,不是不給。** 停住的症狀是「這個病不會再出現了」,
  使用者會以為題庫壞了。
- **這條線今天就能上**,不需要新內容、不需要 migration、不碰 import。
  而它服務的是每天在用的那條路。

## §10 非目標

- **不做全真跑台。** 見 §3 第五條。
- **不判定中途的形態描述。** 見 §3 第二條。
- **不標倍率。** 來源沒寫,標了就是猜的,而「低倍」標成「高倍」會直接教錯判讀順序。
  順序用 PB 在前 BM 在後,那也是真的跑台的順序。
- **ASH 只收 8 案**(§2.1),其餘 126 案 v2。
- **不接手把。** 沿用 overview §11 既有的缺口,那一塊要 Layer 2 的情境判斷。
- **不混進首頁熱力圖 / 弱點地圖 / 成績頁。** 同整個抹片模組的第一條原則。

## §11 分期

| 期 | 內容 | 依賴 | 大小 |
| --- | --- | --- | --- |
| **P0** | import 非破壞化(§8) | — | M |
| **P1** | 抽題輪替(§9)+ 詞彙補齊(`cll` / `t_pll` / `b_pll`) | 詞彙補齊要 P0 | S |
| **P2** | 和信管線(12 案)+ `smear_cases` / `smear_case_items` + `/smear/station` | P0 | L |
| **P3** | ASH 8 案(§2.1)—— 需要 modality 分類 | P2 | M |
| **P4** | Alberta OER 補 RBC 單張題 | P0 | M |
| **P5** | ASH 其餘 126 案(可選) | P3 上線並有人用過 | M |

⚠️ **P3 是 v1 的一部分,不是可選的** —— 少了它,MDS、HCL、MCL、PV、ET、thalassemia、
AA/PNH 這幾個跑台常入題的病就沒有案例。但它排在 P2 之後,因為 ASH 需要 modality
分類而和信不需要;先把不需要模型的那 12 案跑通,分類錯了才看得出來是分類的問題。

**P1 的抽題輪替可以先於 P0 上線** —— 它不碰 import。
如果只做得完一件事,做那一件:它回答了學長第二句話,而且成本最低。

## §12 驗證

| 層 | 驗什麼 |
| --- | --- |
| `worker/lib/smear-pick.test.ts` | `pickUnseenFirst()` 的四個邊界 |
| `worker/lib/smear-case.test.ts` | 案例步驟推進、最後一步的判定沿用 `gradeSmear()` |
| `frontend/e2e/smear-station.test.mjs` | 完整流程;**每一步之前掃整頁原始碼找不到該 dx 的任何寫法**;附自我驗證那一條 |
| `frontend/e2e/smear-practice.test.mjs` | 既有 12 條不得變紅 |
| `sw-guards.test.ts` | `/api/smear/cases*` 不在 `CACHEABLE_API` |
| `eink.test.mjs` | 新路由要進掃描 —— 案例頁的圖與說明是新的一塊畫面 |
| 上線前 | `SELECT COUNT(*) FROM smear_cases`、`smear_case_items`(§7) |

## §13 還沒決定的

留給實作時再問,不要現在猜:

- 案例清單要不要顯示「這一案有幾張圖」。張數本身是弱線索(BM 有做代表病情到某個程度),
  但不顯示的話使用者不知道還要看多久。
- 中途的自由輸入要不要有字數下限。空著直接按下一張,等於把逐步揭露變成一次攤開。
- `steps_seen` 要不要給平均值當回饋(「別人平均 4.1 張」)。20 個人的樣本可能太小。
授權那一項已經確認可用(2026-09-09),不再是阻擋條件。

---

## §14 實作紀錄(2026-09-10)

設計寫完隔天一路做到底。這一節記的是**設計沒說對、實作才知道的事** ——
上面那些節保留原樣,不要回頭改成「早就想到了」。

### 做了什麼

| 期 | 狀態 | 東西 |
| --- | --- | --- |
| P0 | ✅ | `import.ts` 非破壞化:內容表 UPSERT、使用者表不碰、`--wipe-user-data` 只准 local |
| P1 | ✅ | `pickUnseenFirst()` 抽題輪替 + 詞彙補齊(cll / t_pll / b_pll / pv / aplastic_anemia,後續又補 11 個細胞形態) |
| P2 | ✅ | migration 0045、`worker/routes/smear-station.ts`、`/smear/station` 兩頁、和信 6 案 |
| P3 | ✅ | ASH 8 案 |
| P4 | ✅ | Alberta OER 91 張單張題,涵蓋 34 個診斷 |

### 五個實作才發現的坑

**一、投影片上有病人姓名,而這裡是整頁 render。** `Mr.林 41`、`Ms.RO 50`,
七處。`render_pages.py --redact-json` 用 `add_redact_annot` + `apply_redactions`
把文字從文件裡真的拿掉,不是畫白色矩形蓋住 —— 只蓋住的話,中間那份 PDF 哪天
被拿去做別的事,遮蔽就失效了。`import_cases.ts` **一律**傳這個參數,即使清單是空的:
空清單跟「忘了傳」在指令列上長得一樣,而後者的代價是病人姓名上線。

**二、圖說行開頭有項目符號,所以整行被歸進病史 —— 而病史是作答前就顯示的。**
判日期之前沒先剝 `•`,於是 `2022/08/03 BM smear: suspect AML` 整行落進病史,
那 39% 的判讀全部被印在題目上。**畫面上完全看不出來**:病史本來就該有日期跟檢驗。

**三、ASH 的「病史」混著 WHO 分類路徑,而那條路徑逐字寫著診斷。** 補了一道
pre-flight:病史含這一案自己任何一個 accepted term 就遮成 `▮▮▮` 並印出來。
⚠️ 第一版是**刪整行**,結果把 ASH 的臨床病史連根拔掉 —— 而「有病史」正是把它們
選進 v1 的理由。**洩的是那個詞,不是那句話。**

**四、e2e 只掃 DOM 抓不到 payload 洩題。** 自我驗證那條(故意讓 GET 帶
`reveal_note`)在只掃 `page.content()` 的版本下是**綠的**,因為 UI 剛好沒渲染
那個欄位。而「剛好沒渲染」不是保證。改成連回應本文一起掃。

**五、章節頁上的圖不一定在講這一章的主題。** acanthocyte 那章夾了一張
agglutination,bite cell 那章夾了一張 MAHA —— 對比用的。`prepare_oer.py` 的
`audit()` 拿檔名跟詞表交叉比對,對不上就標 `needs_review`、import 跳過。
⚠️ **那是網不是保證**:它靠「檔名寫著別的診斷的**詞表裡的詞**」,而詞表不見得
收了那個字面。兩張是人眼看出來後手動排除的。同理 ASH 的標題比對:
只比 `title` 不要連 `category` 一起比,否則 `aplastic_anemia` 會挑到
「Nucleated red blood cell」——那是分類路徑裡剛好有那個詞。

### 兩件設計時判斷錯的

**「和信的案界要有結束錨點」是多慮的。** 這批投影片**每一張都重複帶著
`Case N:` 標題**,所以正確的規則是逐頁問「這一頁掛的是哪一案」,連結束錨點
都不需要。而且 Smear-1 根本沒有 Outline 頁 —— 第一版把它寫成硬性前提,
於是整份 Smear-1 一案都出不來。

**「和信 16 案」高估了。** 實際只有 6 案的正解在檔案裡找得到。這批是講課
投影片,`Case 3: ALL vs. FL?` 的答案是**口頭講的**,全份掃不到任何
final diagnosis / impression / conclusion。`data/case-dx.json` 因此是人審檔,
`needs_review` 的 10 案 import 直接跳過。**要補到 20 案,需要有人把那 10 案的
正解填上** —— 那不是程式問題。

### 還沒做的

- **和信那 10 案的正解**(`data/case-dx.json`)。填完重跑 `import_cases.ts` 就進去了。
- **Smear-2/3/4 的單張題。** 那三份是疾病分類教學片,T-PLL / B-PLL 在裡面,
  但**頁面是多格對照**(一頁同時放 B-ALL / B-PLL / T-ALL / T-PLL),整頁掛一個
  診斷會標錯。t_pll / b_pll 的圖改從本機 ASH image bank 補進 `ash-map.json`。
- **`--remote` 一次都還沒跑。** 上線前要:`pnpm db:migrate:remote`(0045)、
  `import.ts --remote`、`import_cases.ts --remote`、`import_oer.ts --remote`,
  然後 `SELECT COUNT(*) FROM smear_case_items` 確認不是空的。
- **`import_oer.ts` 是 UPSERT,改了 id 規則會留下孤兒列。** 實際發生過:
  id 規則修掉撞號之後,舊的 60 列還在,`source='oer'` 變成 151 筆而不是 91 筆。
  改 id 規則時要自己下 `DELETE ... WHERE source='oer' AND id NOT IN (...)`。
