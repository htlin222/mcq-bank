"""投影片每頁 → 兩張 WebP。

整頁 render 而不是 pdfimages 抽單張:箭頭、A/B 標記、多圖並列都是畫在投影片
上的,抽單張會把它們丟掉,而那幾題就無解了。代價是白邊 —— 所以 trim。

存兩份:
  view  長邊 1600  預設顯示
  full  長邊 2400  點開放大(顯微鏡細節在 1600 下看不清)

⚠️ trim 的門檻用 250 不是 254。投影片背景常帶極淡的底紋,254 會讓
trim_box 認為整頁都有內容而完全不裁。
"""
import argparse
import os

import fitz  # PyMuPDF
from PIL import Image

DPI = 300
TRIM_THRESHOLD = 250
TRIM_MARGIN = 8
VIEW_LONG_EDGE = 1600
FULL_LONG_EDGE = 2400
WEBP_QUALITY = 82


def trim_box(rows, threshold, margin=0):
    """rows: 灰階像素二維陣列(row-major)。回 (l, t, r, b) 或 None。

    None 代表全頁沒有比 threshold 暗的像素(例如全白頁)——呼叫端應該保留
    原圖,不要硬裁成 0×0。
    """
    h = len(rows)
    w = len(rows[0]) if h else 0
    top = bottom = left = right = None
    for y in range(h):
        for x in range(w):
            if rows[y][x] < threshold:
                if top is None:
                    top = y
                bottom = y
                left = x if left is None else min(left, x)
                right = x if right is None else max(right, x)
    if top is None:
        return None
    return (
        max(0, left - margin),
        max(0, top - margin),
        min(w, right + 1 + margin),
        min(h, bottom + 1 + margin),
    )


def _resize_to_long_edge(img: Image.Image, long_edge: int) -> Image.Image:
    w, h = img.size
    if max(w, h) <= long_edge:
        return img
    if w >= h:
        new_w, new_h = long_edge, round(h * long_edge / w)
    else:
        new_w, new_h = round(w * long_edge / h), long_edge
    return img.resize((new_w, new_h), Image.LANCZOS)


def render_page(page: "fitz.Page") -> Image.Image:
    """Render 一頁成裁邊後的 RGB PIL Image(未縮放)。"""
    pix = page.get_pixmap(dpi=DPI)
    mode = "RGBA" if pix.alpha else "RGB"
    img = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
    if mode == "RGBA":
        img = img.convert("RGB")

    gray = img.convert("L")
    rows = list(gray.getdata())
    w, h = gray.size
    rows = [rows[y * w : (y + 1) * w] for y in range(h)]

    box = trim_box(rows, TRIM_THRESHOLD, TRIM_MARGIN)
    if box is not None:
        img = img.crop(box)
    return img


def render_deck(deck_path: str, out_dir: str, limit: int = 0) -> list[str]:
    """把 deck_path 每一頁(1-based 頁碼)render 成 view/full 兩份 WebP,
    寫進 out_dir。回傳寫出的檔案路徑清單。
    """
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(deck_path))[0]

    written = []
    doc = fitz.open(deck_path)
    try:
        page_count = len(doc)
        n_pages = page_count if not limit else min(limit, page_count)
        for i in range(n_pages):
            page = doc[i]
            page_num = i + 1  # 1-based:對應人類講的「第 18 頁」
            trimmed = render_page(page)

            for label, long_edge in (("view", VIEW_LONG_EDGE), ("full", FULL_LONG_EDGE)):
                resized = _resize_to_long_edge(trimmed, long_edge)
                out_path = os.path.join(
                    out_dir, f"{stem}-{page_num:03d}-{label}.webp"
                )
                resized.save(out_path, "WEBP", quality=WEBP_QUALITY)
                written.append(out_path)
    finally:
        doc.close()
    return written


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deck", required=True, help="投影片 PDF 路徑")
    parser.add_argument("--out", required=True, help="輸出目錄")
    parser.add_argument(
        "--limit", type=int, default=0, help="最多 render 幾頁(0 = 全部)"
    )
    args = parser.parse_args()

    written = render_deck(args.deck, args.out, args.limit)
    for path in written:
        print(path)


if __name__ == "__main__":
    main()
