#!/usr/bin/env python3
"""Render today's work as a self-contained SVG infographic (no deps)."""
import json, glob, os, html

BASE = "/tmp/hema_anki"
SRC = os.environ.get("HEMA_FINAL_DIR", "final5")
TOPIC = {1: "WBC-I 骨髓白血病/急性白血病", 2: "WBC-II 淋巴瘤/骨髓瘤", 3: "初級止血 (platelet/vWF)",
         4: "凝血血栓 (coag/DOAC)", 5: "RBC 紅血球/貧血", 6: "輸血醫學", 7: "兒科血液"}
COLOR = {1: "#c1440e", 2: "#1d6a96", 3: "#2e8b57", 4: "#6a4c93", 5: "#b8860b", 6: "#0d7377", 7: "#9c4f96"}

q_by = {k: 0 for k in TOPIC}
c_by = {k: 0 for k in TOPIC}
total_cards = 0
for f in glob.glob(f"{BASE}/{SRC}/*.json"):
    g = json.load(open(f, encoding="utf-8"))
    t = g["topic_index"]; n = len(g.get("cards", []))
    q_by[t] += 1; c_by[t] += n; total_cards += n
n_q = sum(q_by.values())

W, H = 920, 760
rows = []
maxc = max(c_by.values()) or 1
bx, bw = 360, 460
y = 250
for k in range(1, 8):
    frac = c_by[k] / maxc
    w = int(bw * frac)
    yc = y
    rows.append(
        f'<text x="350" y="{yc+15}" text-anchor="end" font-size="14" fill="#2b2b2b">{html.escape(TOPIC[k])}</text>'
        f'<rect x="{bx}" y="{yc}" width="{w}" height="22" rx="3" fill="{COLOR[k]}"/>'
        f'<text x="{bx+w+8}" y="{yc+16}" font-size="13" fill="#555">{c_by[k]} 卡 · {q_by[k]} 題</text>'
    )
    y += 36

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="-apple-system,Helvetica,Arial,'PingFang TC',sans-serif">
<rect width="{W}" height="{H}" fill="#faf8f4"/>
<text x="40" y="50" font-size="26" font-weight="700" fill="#1a1a1a">今日工作統計 · 血液專科考古題 → Anki</text>
<text x="40" y="78" font-size="15" fill="#777">民國 114 / 113 / 112 年 · 每年 100 題 · 七大主題分類 · WebSearch 實證加值</text>
<line x1="40" y1="96" x2="{W-40}" y2="96" stroke="#e0d9cc" stroke-width="2"/>

<!-- pipeline cards -->
<g>
<rect x="40" y="120" width="200" height="88" rx="8" fill="#fff" stroke="#e0d9cc"/>
<text x="140" y="150" text-anchor="middle" font-size="14" fill="#777">題目處理</text>
<text x="140" y="188" text-anchor="middle" font-size="34" font-weight="700" fill="#c1440e">300</text>
<rect x="260" y="120" width="200" height="88" rx="8" fill="#fff" stroke="#e0d9cc"/>
<text x="360" y="150" text-anchor="middle" font-size="14" fill="#777">最終卡片 (5/題)</text>
<text x="360" y="188" text-anchor="middle" font-size="34" font-weight="700" fill="#2e8b57">{total_cards}</text>
<rect x="480" y="120" width="200" height="88" rx="8" fill="#fff" stroke="#e0d9cc"/>
<text x="580" y="150" text-anchor="middle" font-size="14" fill="#777">OE/WebSearch 查證</text>
<text x="580" y="188" text-anchor="middle" font-size="34" font-weight="700" fill="#1d6a96">300</text>
<rect x="700" y="120" width="180" height="88" rx="8" fill="#fff" stroke="#e0d9cc"/>
<text x="790" y="150" text-anchor="middle" font-size="14" fill="#777">「本例」殘留</text>
<text x="790" y="188" text-anchor="middle" font-size="34" font-weight="700" fill="#6a4c93">0</text>
</g>

<text x="40" y="238" font-size="17" font-weight="600" fill="#1a1a1a">七大主題分佈 (卡片數 · 題數)</text>
{''.join(rows)}

<!-- pipeline funnel text -->
<text x="40" y="{y+30}" font-size="17" font-weight="600" fill="#1a1a1a">製作流程</text>
<text x="40" y="{y+58}" font-size="14" fill="#444">① 讀 300 題題幹+共筆詳解 → ② 七大主題分類 → ③ 每題 WebSearch 挖 high-yield 實證</text>
<text x="40" y="{y+80}" font-size="14" fill="#444">→ ④ 生成自成一體卡 (無「本例」) + 出題者考點/臨床/實證 footer → ⑤ 精選每題最高價值 5 張</text>
<text x="40" y="{y+102}" font-size="14" fill="#444">→ ⑥ footer 接在每張卡後 → ⑦ 灌入 AnkiWeb「02_Hematology_enrich」七個 subdeck</text>
<text x="40" y="{H-24}" font-size="12" fill="#999">deck: 02_Hematology_enrich::1~7 · 卡片格式: 簡問 / 簡答 / &lt;hr&gt; 脈絡 + footer · 繁中保留英文專有名詞</text>
</svg>'''
open(f"{BASE}/today_stats.svg", "w", encoding="utf-8").write(svg)
print(f"chart written: {n_q} questions, {total_cards} cards, {total_cards/n_q:.1f}/q")
print("by topic cards:", c_by)
