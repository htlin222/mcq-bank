#!/usr/bin/env python3
"""Generate SQL to promote 3 OE-verified answer challenges for 114-054, 114-090, 114-094.

Pattern mirrors worker/lib/challenges.ts promote() flow:
  1. Insert lazy original baseline into answer_history (if not present)
  2. Insert challenge-credited flip into answer_history (source='challenge')
  3. Update questions.answer (guarded by current value)
  4. Update answer_challenges to status='promoted', resolution_reason='admin:oe-verdict'
  5. Replace explanation body with OE-backed rewrite, bump version, snapshot to history

Output: a single SQL file ready to be applied with wrangler d1 execute --file.
"""

import json
from pathlib import Path

ADMIN = "ppoiu87@gmail.com"

P = lambda text, marks=None: {  # noqa: E731
    "type": "text",
    **({"marks": marks} if marks else {}),
    "text": text,
}
PAR = lambda children: {"type": "paragraph", "content": children}  # noqa: E731
BOLD = [{"type": "bold"}]
ITALIC = [{"type": "italic"}]


def note_block(date: str, new_answer: str, prev_answer: str) -> dict:
    return {
        "type": "blockquote",
        "content": [
            PAR([P(
                f"📌 答案於 {date} 經 OE 證據複核修正為 {new_answer}（原為 {prev_answer}），詳解已同步重寫。",
                ITALIC,
            )])
        ],
    }


# -------------------------------- 114-054 --------------------------------

doc_054 = {
    "type": "doc",
    "content": [
        note_block("2026-05-25", "D", "E"),
        PAR([
            P("題目要求挑選 ", ),
            P("least accurate", BOLD),
            P(" 的敘述。重點落在 (D) vs (E)。"),
        ]),
        PAR([P("(E) KMT2D 機轉與比例", BOLD)]),
        PAR([
            P("KMT2D 是 H3K4 mono/di-methyltransferase，正常在 enhancer/super-enhancer 區寫入 H3K4me marks 來活化 transcription。Inactivating mutation 屬 loss-of-function：H3K4me 寫不上去，原本「透過 H3K4 methylation 達到 transcription activation」這條 pathway 就 disrupt（非 active demethylation；那是 KDM5/KDM6 的事）。"),
        ]),
        PAR([
            P("FL 中 KMT2D 突變比例文獻多落在 70–80%（Zhang Nat Med 2015、Ortega-Molina Nat Med 2015、Pasqualucci Immunol Rev 2019）。題目寫 \"over 80%\" 略偏高，但機轉描述與大方向正確——(E) 屬 acceptable 敘述。"),
        ]),
        PAR([P("(D) Healthy individuals 中 t(14;18) 的預測力", BOLD)]),
        PAR([
            P("Roulland S et al., JCO 2014 EPIC nested case-control（N=520，prospective）顯示：healthy donor blood 中"),
            P(" high-burden t(14;18) (>10⁻⁴ frequency) ", BOLD),
            P("預測未來 FL "),
            P("OR 23.17 (95% CI 9.98–67.31, p<0.001)", BOLD),
            P("，最早可在 FL 診斷前 15 年偵測；molecular backtracking 也確認 FL 是從預先存在的 t(14;18) clone 演化而來。"),
        ]),
        PAR([
            P("雖然 low-level t(14;18) 在 30–60% healthy 人都驗得到、絕大多數不會發 FL（Schüler IJC 2009），題目寫「generally does not indicate a higher risk」對 high-burden subgroup 直接失準，與 prospective evidence contradict。"),
        ]),
        PAR([
            P("結論", BOLD),
            P("：(E) 與 Wintrobe 15e / Pasqualucci 機轉一致；(D) 與 Roulland 2014 EPIC 結果衝突——least accurate 是 "),
            P("(D)", BOLD),
            P("。"),
        ]),
        PAR([P("References", BOLD)]),
        PAR([P("Roulland S et al. JCO 2014;32(13):1347–55. doi:10.1200/JCO.2013.52.8190")]),
        PAR([P("Zhang J et al. Nat Med 2015;21(10):1190–8. doi:10.1038/nm.3940")]),
        PAR([P("Ortega-Molina A et al. Nat Med 2015;21(10):1199–208. doi:10.1038/nm.3943")]),
        PAR([P("Pasqualucci L. Immunol Rev 2019;288(1):240–61. doi:10.1111/imr.12745")]),
        PAR([P("OpenEvidence article d5574642-adad-414f-be63-a89aecdae77b")]),
    ],
}


# -------------------------------- 114-090 --------------------------------

doc_090 = {
    "type": "doc",
    "content": [
        note_block("2026-05-25", "D", "A"),
        PAR([
            P("題目問 ", ),
            P("錯誤", BOLD),
            P(" 敘述。關鍵落在 (D)「Cefepime 對 ESBL E. coli 也有效」是否成立。"),
        ]),
        PAR([P("(D) Cefepime vs ESBL E. coli — WRONG", BOLD)]),
        PAR([
            P("IDSA AMR 2024 guidance（Tamma PD et al. CID 2024, ciae403）"),
            P(" 建議 avoid cefepime for invasive ESBL-E infections", BOLD),
            P("：ESBL 普遍水解 cefepime；即使 in vitro MIC susceptible 也 unreliable（inoculum effect + ESBL 持續水解）。ESBL pyelonephritis trial 因 cefepime arm 失敗率過高提早終止；ESBL 肺炎 cefepime 失敗 31% (4/13) vs imipenem-cilastatin 0% (0/10)。"),
        ]),
        PAR([
            P("MERINO trial (Harris PNA et al., JAMA 2018, N=391) 測 pip-tazo vs meropenem 處理 ESBL E. coli/Klebsiella bacteremia：30-day mortality 12.3% vs 3.7% (risk difference 8.6%)，trial 提早終止。IDSA AMR 2024 把 cefepime 跟 pip-tazo 同歸為「對 ESBL bacteremia clinical 不可靠」一類；"),
            P("carbapenem 是首選", BOLD),
            P("。"),
        ]),
        PAR([P("(A) Ceftazidime no longer good monotherapy — 屬正確敘述", BOLD)]),
        PAR([
            P("NCCN 2026 v1 Prevention and Treatment of Cancer-Related Infections 已 downgrade ceftazidime 到 "),
            P("Category 2B", BOLD),
            P("：「weak Gram-positive coverage and increased breakthrough infections limit utility」、「breakthrough streptococcal infections reported」。雖然題目寫「對 GPC 也無效」用詞偏絕對（應為 weak coverage），但「已不再是 monotherapy 的好選擇」與 NCCN 2026、ASCO/IDSA 2018 update 立場一致。"),
        ]),
        PAR([P("其他選項簡釋", BOLD)]),
        PAR([P("(B) Pip-tazo 廣效 GNB/GPC，CNS penetration 差，NCCN 不建議 meningitis 使用——正確。")]),
        PAR([P("(C) Carbapenem 涵蓋 GNB/GPC + anaerobes；meropenem seizure 風險低於 imipenem（NCCN preferred for CNS infection）——正確。")]),
        PAR([P("(E) Vancomycin 不被建議作為 FN 第一線（IDSA 2010、ASCO/IDSA 2018、NCCN 2026 共識）——正確。")]),
        PAR([
            P("結論", BOLD),
            P("：(D) 與 IDSA AMR 2024 + MERINO trial 直接 contradict，是 the WRONG statement。答案 "),
            P("(D)", BOLD),
            P("。"),
        ]),
        PAR([P("References", BOLD)]),
        PAR([P("Tamma PD et al. CID 2024;ciae403. doi:10.1093/cid/ciae403  (IDSA AMR Guidance 2024)")]),
        PAR([P("Harris PNA et al. JAMA 2018;320(10):984–94. doi:10.1001/jama.2018.12163  (MERINO)")]),
        PAR([P("NCCN Guidelines, Prevention and Treatment of Cancer-Related Infections v1.2026")]),
        PAR([P("Taplitz RA et al. JCO 2018;36(14):1443–53. doi:10.1200/JCO.2017.77.6211  (ASCO/IDSA outpatient FN)")]),
        PAR([P("OpenEvidence article 31e842b6-dacd-4ea3-b18d-ebff8fb28410")]),
    ],
}


# -------------------------------- 114-094 --------------------------------

doc_094 = {
    "type": "doc",
    "content": [
        note_block("2026-05-25", "C", "A"),
        PAR([
            P("題目問依據 Taiwan CML treatment guideline 哪一條 ", ),
            P("not adequate", BOLD),
            P(" 為 TKI discontinuation 的 candidate criterion。"),
        ]),
        PAR([P("Taiwan CML Guideline 2020 (Taiwan CML Working Group I&II) p.37 條文", BOLD)]),
        PAR([P("Mandatory（4 條缺一不可）：CML in first CP only；motivated patient；high-quality qPCR；more frequent monitoring agreement。", ITALIC)]),
        PAR([P("Minimal：First-line therapy OR second-line if intolerance was the only reason for changing TKI；typical e13a2/e14a2；TKI duration >5 yr（>4 yr 若 2GTKI）；DMR (MR4 or better) >2 yr。", ITALIC)]),
        PAR([P("Optimal：TKI duration >5 yr；DMR >3 yr if MR4 或 >2 yr if MR4.5；No prior treatment failure。", ITALIC)]),
        PAR([P("(C) First-line failure 後 second-line 達 DMR 也是 candidate — NOT adequate", BOLD)]),
        PAR([
            P("這項與 Taiwan guideline 雙重 contradict："),
        ]),
        PAR([
            P("1. Minimal requirement 明列 second-line 「"),
            P("only if intolerance was the sole reason", BOLD),
            P("」for changing TKI——換 TKI 的理由必須是 intolerance（無法耐受），不是 failure（療效不足/resistance）。"),
        ]),
        PAR([
            P("2. Optimal requirement 明列 「"),
            P("No prior treatment failure", BOLD),
            P("」——prior failure 直接 exclude。"),
        ]),
        PAR([
            P("ENESTop (Hughes 2017 Blood, N=126, imatinib→nilotinib) 與 DASFREE (Shah 2020 Leukemia) 確實顯示精選 second-line cohort 有 TFR 可行性，但 Inzoli AJH 2022 meta 直接量化差異：48-mo TFR 在 intolerance/first-line cohort 為 "),
            P("62.4%", BOLD),
            P(" vs resistance cohort 僅 "),
            P("23.1%", BOLD),
            P("。Taiwan 2020 + ELN 2020 都把 prior failure 後的 TFR 列為 controversial/investigational，不在 standard candidate criteria。"),
        ]),
        PAR([P("(A) Chronic phase only — 屬有效 requirement", BOLD)]),
        PAR([P("Taiwan guideline mandatory 第一條，ELN 2020、NCCN 2025、Wintrobe 15e Ch 83 三方共識——absolute requirement。")]),
        PAR([P("(B) High-quality qPCR — 屬有效 requirement", BOLD)]),
        PAR([P("Mandatory 第三條，三方共識。")]),
        PAR([P("(D) Typical e13a2/e14a2 BCR-ABL1 transcripts — 屬有效 requirement", BOLD)]),
        PAR([P("Minimal requirement 第二條。Atypical transcripts (e1a2、e19a2 等) 因 qPCR 標準化困難而排除。")]),
        PAR([P("(E) Optimal DMR duration — 屬有效 requirement（題目 MR3 為 typo）", BOLD)]),
        PAR([
            P("題目寫「>3 years (if MR3)」應為 "),
            P("MR4", BOLD),
            P("（MR3 = MMR = 3-log reduction，根本不算 DMR）。撇開 typo，「>3 yr if MR4 / >2 yr if MR4.5」與 Taiwan guideline optimal 條文一致——概念正確。"),
        ]),
        PAR([
            P("結論", BOLD),
            P("：(A)、(B)、(D)、(E) 都是 Taiwan guideline 列出的 valid requirement；只有 (C) 與 minimal 的「intolerance only」+ optimal 的「No prior treatment failure」直接 contradict——not adequate。答案 "),
            P("(C)", BOLD),
            P("。"),
        ]),
        PAR([P("References", BOLD)]),
        PAR([P("Taiwan CML Working Group I&II. Taiwan Guidelines for the Management of Chronic Myeloid Leukemia 2020-12-05, p.37")]),
        PAR([P("Hochhaus A et al. Leukemia 2020;34(4):966–84. doi:10.1038/s41375-020-0776-2  (ELN 2020)")]),
        PAR([P("Inzoli E et al. Am J Hematol 2022;97(8):1075–85. doi:10.1002/ajh.26556")]),
        PAR([P("Cortes J et al. Lancet 2021;398:1914–26. doi:10.1016/S0140-6736(21)01204-6")]),
        PAR([P("NCCN Guidelines, Chronic Myeloid Leukemia v3.2025")]),
        PAR([P("OpenEvidence article 2d38fb22-91fc-4628-b914-c3416896b877")]),
    ],
}


JOBS = [
    {
        "qid": "114-054",
        "challenge_id": "1847346d-0ff8-46f1-be2e-195ce6de8ee4",
        "proposer": "chenpohuang@gmail.com",
        "prev": "E",
        "new": "D",
        "doc": doc_054,
    },
    {
        "qid": "114-090",
        "challenge_id": "7221a4bd-c1f4-49c2-b791-0227b0e3725f",
        "proposer": "chenpohuang@gmail.com",
        "prev": "A",
        "new": "D",
        "doc": doc_090,
    },
    {
        "qid": "114-094",
        "challenge_id": "d403c73e-7f9b-4c2b-b767-255966c8c6c6",
        "proposer": "chenpohuang@gmail.com",
        "prev": "A",
        "new": "C",
        "doc": doc_094,
    },
]


def sql_str(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def emit(job: dict) -> str:
    qid = sql_str(job["qid"])
    ch_id = sql_str(job["challenge_id"])
    proposer = sql_str(job["proposer"])
    prev = sql_str(job["prev"])
    new = sql_str(job["new"])
    admin = sql_str(ADMIN)
    doc_json = sql_str(json.dumps(job["doc"], ensure_ascii=False, separators=(",", ":")))

    return f"""\
-- ============================================================
-- {job['qid']}  (challenge {job['challenge_id']})  {job['prev']} → {job['new']}
-- ============================================================

-- 1. Lazy-insert original baseline into answer_history (idempotent)
INSERT INTO answer_history
  (question_id, previous_answer, new_answer, source, challenge_id, changed_by, changed_at)
SELECT id, answer, answer, 'original', NULL, NULL, strftime('%s','now') * 1000
FROM questions
WHERE id = {qid}
  AND NOT EXISTS (SELECT 1 FROM answer_history WHERE question_id = {qid});

-- 2. Record the challenge-credited flip (proposer keeps authorship)
INSERT INTO answer_history
  (question_id, previous_answer, new_answer, source, challenge_id, changed_by, changed_at)
SELECT id, answer, {new}, 'challenge', {ch_id}, {proposer}, strftime('%s','now') * 1000
FROM questions
WHERE id = {qid} AND answer = {prev};

-- 3. Flip the answer (guarded — only if still on previous value)
UPDATE questions
SET answer = {new}
WHERE id = {qid} AND answer = {prev};

-- 4. Mark the challenge promoted with an admin/OE resolution reason
UPDATE answer_challenges
SET status = 'promoted',
    resolved_at = strftime('%s','now') * 1000,
    resolution_reason = 'admin:oe-verdict'
WHERE id = {ch_id} AND status IN ('open', 'contested');

-- 5. Replace explanation body, bump version, snapshot to history
UPDATE explanations
SET content_json = {doc_json},
    version      = COALESCE(version, 0) + 1,
    updated_by   = {admin},
    updated_at   = strftime('%s','now') * 1000,
    editing_by   = NULL,
    editing_until= NULL,
    stale_since  = NULL
WHERE question_id = {qid};

INSERT INTO explanation_history (question_id, version, content_json, updated_by, updated_at)
SELECT question_id, version, content_json, updated_by, updated_at
FROM explanations WHERE question_id = {qid};
"""


def main() -> None:
    sql_parts = [
        "-- Auto-generated by scripts/apply-oe-verdicts.py",
        "-- Promotes 3 chenpohuang challenges that OpenEvidence verdicts confirmed.",
        "-- Mirrors the worker/lib/challenges.ts promote() flow but rewrites the",
        "-- explanation body in the same pass instead of leaving a stale system note.",
        "",
    ]
    for job in JOBS:
        sql_parts.append(emit(job))
    out = Path("scripts/apply-oe-verdicts.sql")
    out.write_text("\n".join(sql_parts))
    print(f"Wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
