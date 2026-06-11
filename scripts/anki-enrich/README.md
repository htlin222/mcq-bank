# Anki 血液專科考古題加值卡 製作流程

把民國 **114 / 113 / 112** 三年血液專科考古題（共 300 題）＋共筆詳解，轉成
high-yield board-exam Anki 卡片，灌進 AnkiWeb 牌組 **`02_Hematology_enrich`**
（七大主題 subdeck，每題精選 5 張，2026-06-02 製作）。

## 成果
- **1,500 張卡**（300 題 × 5 張），分七大主題 subdeck：
  WBC-I 455 / WBC-II 295 / Coag-I 145 / Coag-II 140 / RBC 355 / Transfusion 105 / Pediatric 5
- 卡片格式：**簡問 / 簡答 / `<hr>` 補脈絡**，繁中保留英文專有名詞，**自成一體（無「本例」）**
- 每題第 1 張（核心卡）附 **footer**：📌出題者考點 / 🏥臨床意義 / ⭐High-yield / 🔬實證（含來源年份）；其餘 4 張乾淨
- 每題經 **WebSearch 實證**查證（OE 被 DataDome 擋後改用 web search）
- tag：`enriched` ＋疾病標籤 ＋ `Y<年>` ＋ `Q<題號>`

## 七大主題分類（依 `REPO/pdf/` 七場講義）
1 骨髓白血病(WBC-I, AML/MDS/MPN/CML/ALL/HSCT) · 2 淋巴瘤(WBC-II, lymphoma/CLL/myeloma)
· 3 初級止血(platelet/vWF/ITP/TTP) · 4 凝血血栓(coag/hemophilia/DOAC/thrombophilia/DIC)
· 5 紅血球貧血(anemia/thalassemia/hemolysis/PNH) · 6 輸血醫學 · 7 兒科血液。每題只歸一主題。

## Pipeline（依序）
| 步驟 | 腳本 | 說明 |
|---|---|---|
| 1. 抽取 | `extract.py` | `years/{112,113,114}/batches/*.json` → `data/questions_300.json` + per-question `q/<id>.json` |
| 2. 生成 | `final_workflow.js` | 平行 workflow：每題讀題+詳解 → WebSearch → 產 ≥10 張自成一體卡 + footer → `final/<id>.json` |
| 3. 精選 | `select5_workflow.js` | 每題從 ~12 張挑**最高價值 5 張** → `data/final5/<id>.json` |
| 4. 合併 | `merge_final.py` | footer 接到每題**第 1 張**卡的 Back（`HEMA_FINAL_DIR`/`HEMA_MERGED_DIR` 可設）→ `merged5/` |
| 5. 灌卡 | `insert_all.py` | 單一 session 直接打 AnkiWeb protobuf，逐張 add（resumable via done-file）|
| (pipeline) | `enrich_finish.sh` | 邊 select 邊 merge+insert，overlap 加速 |
| 6. 圖表 | `generate_chart.py` | 純 Python 產 `today_stats.svg` 統計圖 |

## 重跑方式
```bash
# 灌卡器環境變數（deck prefix / 來源資料夾 / done 檔可換）
HEMA_GEN=/path/to/merged5 \
HEMA_DECK_PREFIX=02_Hematology_enrich \
HEMA_DONE=/path/to/inserted.txt \
python3 insert_all.py
```
- Anki CLI：`~/.claude/skills/anki/anki.py`（`create_deck` / `add_card` / `remove-deck` / `list-decks`）
- **AnkiWeb CLI 僅支援 add，不支援編輯既有卡**；「加值」是以新增方式做，舊卡用 `remove-deck` 整批刪。

## data/
- `final5/<id>.json` — 最終每題 5 張卡 + footer（卡片內容的 source of truth，可重新 merge+insert）
- `questions_300.json` / `ids.json` — 題目來源與順序

## 註記
- 卡片由 WebSearch + LLM 生成，已抽查 8 題 40 張正確性（MORPHO/E1910/PLASMIC/Para-Bombay 等皆正確）；
  正式使用前建議再隨機抽驗。
- 母牌 `02_Hematology` 內早期有 2 張 probe 卡（tag `anki_probe_delete`），手動刪除即可。
