-- Sample data for local development & smoke testing
-- Real 1000 questions should be imported via scripts/import-questions.ts

INSERT INTO questions (id, year, number, stem, options_json, answer, category, difficulty, source, created_at) VALUES
('2024-001', 2024, 1,
 '下列何者為治療幽門桿菌 (H. pylori) 的標準三合一療法?',
 '[{"key":"A","text":"PPI + Amoxicillin + Clarithromycin"},{"key":"B","text":"PPI + Metronidazole + Tetracycline"},{"key":"C","text":"H2 blocker + Bismuth + Amoxicillin"},{"key":"D","text":"PPI 單獨使用 14 天"}]',
 'A', '內科', 2, '113年第一次專技高考', 1735689600000),

('2024-002', 2024, 2,
 '關於急性心肌梗塞的初步診斷,下列何者最具特異性?',
 '[{"key":"A","text":"胸痛 > 30 分鐘"},{"key":"B","text":"Troponin I 上升"},{"key":"C","text":"ECG 出現 ST 段抬高"},{"key":"D","text":"CK-MB 輕度上升"}]',
 'B', '內科', 3, '113年第一次專技高考', 1735689600000),

('2023-001', 2023, 1,
 '下列哪一種抗生素最常引起 C. difficile 相關腹瀉?',
 '[{"key":"A","text":"Vancomycin"},{"key":"B","text":"Clindamycin"},{"key":"C","text":"Gentamicin"},{"key":"D","text":"Penicillin G"}]',
 'B', '感染科', 2, '112年第一次專技高考', 1704067200000);

-- Initialize empty explanations for each
INSERT INTO explanations (question_id, content_json, version, updated_at)
SELECT id, '{"type":"doc","content":[]}', 0, 1735689600000 FROM questions;
