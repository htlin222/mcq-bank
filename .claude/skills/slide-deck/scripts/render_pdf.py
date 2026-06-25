#!/usr/bin/env python3
"""把 slide.html 用 headless Chrome 轉成 16:9 的 slide.pdf。

用法:
    python3 render_pdf.py slides/114/001/slide.html        # 同目錄輸出 slide.pdf
    python3 render_pdf.py slides/114/001/slide.html out.pdf

說明:
    - 頁面尺寸由 HTML 的 @page (13.333in x 7.5in = PowerPoint 16:9) 決定。
    - 圖片用相對路徑(raw/figure-*)時,Chrome 以 HTML 檔位置為基準解析,故無論 cwd 為何皆可。
    - 自動偵測 Chrome/Chromium 路徑。
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    shutil.which("google-chrome-stable") or "",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
    shutil.which("chrome") or "",
]


def find_chrome() -> str:
    for c in CANDIDATES:
        if c and Path(c).exists():
            return c
    sys.exit("找不到 Chrome/Chromium，請安裝或調整 render_pdf.py 的 CANDIDATES。")


def check_overflow(chrome: str, html: Path):
    """偵測哪些 .slide 內容超出固定頁高(overflow:hidden 仍會被裁切)。
    作法:複製一份 HTML 注入量測 script，用 --dump-dom 取回 title 內的溢出頁碼。
    回傳溢出頁碼 list;無法量測時回 None(不阻斷流程)。"""
    probe = ("<script>(function(){var b=[];"
             "document.querySelectorAll('.slide').forEach(function(s,i){"
             "if(s.scrollHeight>s.clientHeight+2)b.push(i+1);});"
             "document.title='OVF:'+JSON.stringify(b);})();</script>")
    src = html.read_text(encoding="utf-8")
    src2 = src.replace("</body>", probe + "</body>", 1) if "</body>" in src else src + probe
    tmp = html.with_name("._ovfprobe.html")
    tmp.write_text(src2, encoding="utf-8")
    try:
        proc = subprocess.run(
            [chrome, "--headless", "--disable-gpu", "--dump-dom",
             "--virtual-time-budget=3000", str(tmp)],
            capture_output=True, text=True, timeout=60)
        m = re.search(r"OVF:(\[[^\]]*\])", proc.stdout)
        return json.loads(m.group(1)) if m else None
    except Exception:
        return None
    finally:
        tmp.unlink(missing_ok=True)


def main():
    if len(sys.argv) < 2:
        sys.exit("用法: render_pdf.py <slide.html> [out.pdf]")
    html = Path(sys.argv[1]).resolve()
    if not html.exists():
        sys.exit(f"找不到 HTML: {html}")
    out = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else html.with_name("slide.pdf")

    chrome = find_chrome()
    cmd = [
        chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
        f"--print-to-pdf={out}", str(html),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if not out.exists():
        sys.stderr.write(proc.stderr[-800:] + "\n")
        sys.exit("PDF 產生失敗")

    # 粗略頁數
    data = out.read_bytes()
    pages = len(re.findall(rb"/Type\s*/Page[^s]", data))
    print(f"OK: {out}  ({pages} 頁, {round(len(data)/1024)} KB)")

    over = check_overflow(chrome, html)
    if over:
        print(f"⚠️  溢出警告：第 {', '.join(map(str, over))} 頁內容超出頁高(被裁切)。"
              f"請精簡該頁或調整版面後重轉。")
    elif over is None:
        print("（無法自動量測溢出，請用 Read 工具目視檢查每頁版面）")
    else:
        print("版面檢查：各頁未偵測到溢出。仍建議目視確認密度與裁切。")


if __name__ == "__main__":
    main()
