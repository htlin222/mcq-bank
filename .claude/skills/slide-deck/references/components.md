# 元件速查（CSS class）

模板 `assets/template.html` 已內含全部 CSS。撰寫每頁內容時，用下列 class 組裝。

## 版面骨架
```html
<section class="slide">
  <div class="kicker"><span class="l">左標</span><span class="r">右標</span></div>
  <h1>標題<span class="sub">斜體副標</span></h1>
  <div class="body"> ...內容... </div>
  <div class="foot"><span>左</span><span>第 N / TOTAL 頁 — 區段</span></div>
</section>
```
- `.body` 是 flex column；想把某元素推到底部用 `style="margin-top:auto"`（常用在 `.takeaway` 或末頁註腳）。

## 清單（巢狀短句）
```html
<ul class="b">
  <li><span class="lead">標籤：</span>主句</li>
  <li>父項<ul><li>次層（空心點）</li></ul></li>
</ul>
```

## 選項（第 1 頁）
```html
<ol class="opt"><li>選項文字（自動標 A、B、C…圓圈）</li></ol>
```

## 雙欄 + 欄標
```html
<div class="cols">
  <div><div class="colhead">欄標題</div><ul class="b">…</ul></div>
  <div><div class="colhead">欄標題</div><ul class="b">…</ul></div>
</div>
```

## 真偽表 / 比較表
```html
<table class="tf">
  <tr><th></th><th>欄</th><th>判定</th></tr>
  <tr><td class="v">A</td><td>…</td><td class="j x">✗ 錯</td></tr>
  <tr><td class="v">B</td><td>…</td><td class="j">✓ 對</td></tr>
</table>
```
- `td.v` 選項字母窄格；`td.j` 判定窄格；`.x` 粗體（標錯誤）。`th` 為黑底白字。

## 考點框（黑底「考點 EXAM PEARL」標籤）
```html
<div class="pearl"><ul class="b"><li>高頻重點 / 陷阱 / 口訣</li></ul></div>
```

## 必背數字卡
```html
<div class="nums">
  <div class="n"><b>10⁻⁴</b><span>說明</span></div>
  <div class="n"><b>85%</b><span>說明</span></div>
</div>
```

## 答案章 / 標籤 / 金句
```html
<span class="ans">答案 A</span>
<span class="tag">關鍵字</span>
<p class="takeaway"><b>一句話帶走 ▸</b> …</p>
```

## meta 條（第 1 頁底部）
```html
<div class="meta">
  <div><div class="k">範疇 Domain</div><div class="vv">…</div></div>
  …共 4 格…
</div>
```

## 圖（灰階）
```html
<div class="fig">
  <div style="flex:1"><ul class="b">…文字…</ul></div>
  <div style="width:2.4in"><img src="raw/figure-1.jpg" alt=""><p class="cap"><span class="t">Figure</span>caption（灰階呈現）</p></div>
</div>
```
- 上標數字用 Unicode（10⁻⁴、CD19）；粗體用 `<b>`，底線強調用 `<u>`。
