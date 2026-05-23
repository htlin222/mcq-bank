-- ============================================================
-- Migration 0004: Hematology sample questions for 民國 100 年
--
-- The original 0002 seeded off-topic 內科/感染科 board questions.
-- Wipe those and replace with 10 hematology-flavored samples
-- under year=100 (= 2011 CE) — a year that will NEVER appear in
-- the real dataset (104..114), so sample rows can be cleared by
-- a one-liner before real import:
--     DELETE FROM questions WHERE year = 100;
-- ============================================================

DELETE FROM explanation_history;
DELETE FROM explanations;
DELETE FROM question_tags;
DELETE FROM questions;

-- ------------------------------------------------------------
-- 內科 (slots 1..7)
-- ------------------------------------------------------------

INSERT INTO questions (id, year, number, "group", stem, options_json, answer, source, created_at) VALUES
('100-001', 100, 1, '內科',
 '一位 58 歲男性,因疲倦、發燒、瘀斑就診。CBC: WBC 28,000/μL (blasts 65%)、Hb 7.2 g/dL、Plt 22,000/μL。骨髓 aspirate 75% myeloblasts、MPO 染色陽性,flow cytometry 確認為 AML (非 APL)。下列何者為標準誘導化療?',
 '[{"key":"A","text":"Cytarabine 100 mg/m²/day × 7 天 + Daunorubicin 60 mg/m² × 3 天 (7+3)"},{"key":"B","text":"ATRA + Arsenic trioxide"},{"key":"C","text":"Rituximab + CHOP"},{"key":"D","text":"Imatinib 400 mg PO QD"}]',
 'A', 'SAMPLE — 100 年模擬題', 1234567890000),

('100-002', 100, 2, '內科',
 '一位 33 歲女性,WBC 1,800/μL、Plt 18,000/μL,fibrinogen 90 mg/dL,有 DIC 證據。PB smear 可見 hypergranular promyelocytes 及 Auer bundles。PML-RARα 陽性。下列何者為一線治療?',
 '[{"key":"A","text":"7+3 induction (cytarabine + daunorubicin)"},{"key":"B","text":"ATRA + Arsenic trioxide"},{"key":"C","text":"立即進行 allogeneic HSCT"},{"key":"D","text":"Rituximab + steroids"}]',
 'B', 'SAMPLE — 100 年模擬題', 1234567890000),

('100-003', 100, 3, '內科',
 '一位 67 歲 multiple myeloma 患者,β2-microglobulin 5.2 mg/L、albumin 3.0 g/dL、LDH 240 U/L (ULN 220)、FISH 偵測到 del(17p)。R-ISS 分期為何?',
 '[{"key":"A","text":"R-ISS I"},{"key":"B","text":"R-ISS II"},{"key":"C","text":"R-ISS III"},{"key":"D","text":"無法判定,需重新做 cytogenetics"}]',
 'C', 'SAMPLE — 100 年模擬題', 1234567890000),

('100-004', 100, 4, '內科',
 '一位 42 歲女性,皮膚瘀斑兩週,Plt 12,000/μL,其餘 CBC 正常,無 splenomegaly,PB smear 無 schistocytes,骨髓 megakaryocytes 增生。診斷為 primary ITP。下列何者為成人一線治療?',
 '[{"key":"A","text":"High-dose dexamethasone 40 mg/day × 4 天"},{"key":"B","text":"Rituximab 375 mg/m² × 4 週"},{"key":"C","text":"TPO-receptor agonist (eltrombopag)"},{"key":"D","text":"Splenectomy"}]',
 'A', 'SAMPLE — 100 年模擬題', 1234567890000),

('100-005', 100, 5, '內科',
 '新診斷 chronic-phase CML (Sokal low risk),BCR-ABL p210 陽性,起始 imatinib 400 mg QD。依 ELN 2020,3 個月時 BCR-ABL/ABL (IS) 應達到何者算 optimal response?',
 '[{"key":"A","text":"≤ 10%"},{"key":"B","text":"≤ 1%"},{"key":"C","text":"≤ 0.1% (MMR)"},{"key":"D","text":"undetectable (MR4.5)"}]',
 'A', 'SAMPLE — 100 年模擬題', 1234567890000),

('100-006', 100, 6, '內科',
 '一位 65 歲男性,DLBCL、GCB subtype、IPI 2、Ann Arbor stage III A、無 bulky disease、ECOG 1。下列何者為標準一線治療?',
 '[{"key":"A","text":"R-CHOP × 6 cycles"},{"key":"B","text":"Dose-adjusted R-EPOCH × 6"},{"key":"C","text":"Bendamustine + Rituximab"},{"key":"D","text":"Axicabtagene ciloleucel (CAR-T) as first line"}]',
 'A', 'SAMPLE — 100 年模擬題', 1234567890000),

('100-007', 100, 7, '內科',
 '一位 70 歲 CLL 患者,absolute lymphocyte count 80,000/μL、bulky lymphadenopathy,即將開始 venetoclax。下列何者為治療前最需要監測與預防的併發症?',
 '[{"key":"A","text":"Tumor lysis syndrome — 漸進 ramp-up、hydration、降尿酸藥物"},{"key":"B","text":"Cardiotoxicity — 治療前 echo"},{"key":"C","text":"Pulmonary fibrosis — baseline DLCO"},{"key":"D","text":"Hyperglycemia — 血糖監測"}]',
 'A', 'SAMPLE — 100 年模擬題', 1234567890000);

-- ------------------------------------------------------------
-- 共同 (slots 71..73)
-- ------------------------------------------------------------

INSERT INTO questions (id, year, number, "group", stem, options_json, answer, source, created_at) VALUES
('100-071', 100, 71, '共同',
 '一名 3 歲男童反覆膝關節腫脹,父系家族有出血病史。實驗室:PT 正常、aPTT 顯著延長 (mixing study 可矯正)、Factor VIII 活性 < 1%、Factor IX 活性正常。診斷為何?',
 '[{"key":"A","text":"von Willebrand disease type 3"},{"key":"B","text":"Hemophilia A, severe"},{"key":"C","text":"Hemophilia B, moderate"},{"key":"D","text":"Vitamin K deficiency"}]',
 'B', 'SAMPLE — 100 年模擬題', 1234567890000),

('100-072', 100, 72, '共同',
 '一名 2 歲幼童,長期蒼白、肝脾腫大、骨骼變形,Hb 6.5 g/dL,需定期輸血。HbA2 3.5%、HbF 80%、HbA 微量。父母皆為地中海後裔。最可能診斷?',
 '[{"key":"A","text":"β-thalassemia major"},{"key":"B","text":"Sickle cell anemia (HbSS)"},{"key":"C","text":"Hereditary spherocytosis"},{"key":"D","text":"G6PD deficiency"}]',
 'A', 'SAMPLE — 100 年模擬題', 1234567890000),

('100-073', 100, 73, '共同',
 '一位 5 歲男童感冒後一週,皮膚出現 petechiae、口腔黏膜出血。CBC: Plt 8,000/μL,其餘正常。PB smear 無異常 blast,physical exam 無 hepatosplenomegaly 或 lymphadenopathy。最可能診斷與初步處置?',
 '[{"key":"A","text":"Acute ITP — 觀察 + 衛教,大多自限"},{"key":"B","text":"AML M7 — 立即 7+3 induction"},{"key":"C","text":"TTP — 立刻 plasma exchange"},{"key":"D","text":"HSP — 高劑量類固醇"}]',
 'A', 'SAMPLE — 100 年模擬題', 1234567890000);

-- ------------------------------------------------------------
-- Initialize empty explanations for each new question
-- ------------------------------------------------------------
INSERT INTO explanations (question_id, content_json, version, updated_at)
SELECT id, '{"type":"doc","content":[]}', 0, 1234567890000 FROM questions;

-- ------------------------------------------------------------
-- Seed tags (free-form, system-authored for samples)
-- ------------------------------------------------------------
INSERT INTO question_tags (question_id, tag, created_by, created_at) VALUES
('100-001', 'AML', 'system@hema-2026', 1234567890000),
('100-001', '誘導化療', 'system@hema-2026', 1234567890000),
('100-002', 'APL', 'system@hema-2026', 1234567890000),
('100-002', 'ATRA', 'system@hema-2026', 1234567890000),
('100-003', 'MM', 'system@hema-2026', 1234567890000),
('100-003', '分期', 'system@hema-2026', 1234567890000),
('100-004', 'ITP', 'system@hema-2026', 1234567890000),
('100-005', 'CML', 'system@hema-2026', 1234567890000),
('100-005', 'TKI', 'system@hema-2026', 1234567890000),
('100-006', 'DLBCL', 'system@hema-2026', 1234567890000),
('100-006', 'R-CHOP', 'system@hema-2026', 1234567890000),
('100-007', 'CLL', 'system@hema-2026', 1234567890000),
('100-007', 'TLS', 'system@hema-2026', 1234567890000),
('100-071', 'hemophilia', 'system@hema-2026', 1234567890000),
('100-071', '小兒', 'system@hema-2026', 1234567890000),
('100-072', 'thalassemia', 'system@hema-2026', 1234567890000),
('100-072', '小兒', 'system@hema-2026', 1234567890000),
('100-073', 'ITP', 'system@hema-2026', 1234567890000),
('100-073', '小兒', 'system@hema-2026', 1234567890000);
