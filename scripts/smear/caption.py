"""投影片圖說的判定 —— parse_cases.py 與 render_pages.py 共用的唯一一份。

一行文字是不是「圖說」,決定了兩件事:
  - 解析時它進 caption / reveal_note,還是進病史(parse_cases.py)
  - render 時它留在圖上,還是被遮掉(render_pages.py --strip-text)

⚠️ 兩邊各寫一份的話,判準一定會漂:解析器認得某種寫法、渲染器不認得,
   那行就會被當成內文遮掉(圖說消失);反過來則是判讀被留在圖上(洩題)。
   後者的症狀在畫面上完全看不出來 —— 圖本來就該帶著日期與模態。
"""
import re

DATE = r"\d{4}/\d{1,2}(?:/\d{1,2})?"

# 兩套模態寫法:`PB smear` / `BM smear` 與 `Peripheral blood` / `Bone marrow`。
# 只認長寫法的話,Smear-5 的 APL 那案會整案標不到模態(實測)。
MODALITIES = [
    ("pb", r"Peripheral blood|PB smear"),
    ("bm", r"Bone marrow|BM smear|Marrow aspirate"),
    ("effusion", r"Pleural effusion|Ascites|effusion"),
    ("aspiration", r"Mass aspiration|FNA|aspiration"),
    ("csf", r"\bCSF\b"),
]
MOD_RE = re.compile("|".join(f"(?P<{k}>{v})" for k, v in MODALITIES), re.I)
CAPTION_RE = re.compile(rf"({DATE})\s*([^\n:：]*?)\s*(?:\(([^)]*)\))?\s*(?:[:：]\s*(.*))?$")
BULLETS = "•· \t"


def detect_modalities(text):
    found = []
    for m in MOD_RE.finditer(text):
        for k, _ in MODALITIES:
            if m.group(k):
                if k not in found:
                    found.append(k)
                break
    return found


def bare(line):
    return line.strip().lstrip(BULLETS)


def is_caption(line):
    """開頭是日期、而且帶模態的那一行。`2025/01/03 輔大H: palpable neck mass`
    有日期沒有模態 —— 那是病史,不是圖說。"""
    b = bare(line)
    return bool(re.match(rf"^{DATE}", b)) and bool(detect_modalities(b))


def split_caption(line):
    """一行圖說 → (左半, 右半)。右半是判讀(`suspect AML`),要當答案處理。

    ⚠️ 61 個帶日期的圖說裡有 24 個(39%)冒號後面直接寫了判讀。
    """
    b = bare(line)
    m = CAPTION_RE.match(b)
    if not m:
        return b, None
    date, what, site, verdict = m.groups()
    left = f"{date} {(what or '').strip()}".strip()
    if site:
        left += f" ({site.strip()})"
    return left, (verdict or "").strip() or None
