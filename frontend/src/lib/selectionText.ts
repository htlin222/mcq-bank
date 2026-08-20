// 選取文字的兩種形態。
//
// 選取每次都要產生兩份文字,因為消費者要的東西相反:
//
//   `flat`  —— 換行、縮排全部壓成單一空格。畫記錨定、AI 的 {{selection}}、
//              教科書查詢都是拿它去「比對」,多一個換行就match 不到。長度
//              上下限也量它,否則排版縮排會把一句話撐過上限。
//   `rich`  —— 保留段落結構。給「原樣帶走」的去處:存到 Telegram(#165)。
//
// 舊版只有 flat,於是選了三段詳解送到 Telegram,收到的是黏成一坨的一整段
// —— 而且 Telegram 那端完全正常,formatSelectionNote 也正常,壞的地方在
// 使用者按下按鈕之前就發生了。

/** 比對用:所有空白(含換行)壓成單一空格。 */
export function flatSelection(raw: string): string {
	return raw.replace(/\s+/g, " ").trim();
}

/**
 * 呈現用:保留換行,但把每一行內部的空白壓平、去掉行首行尾縮排,並把三個以上
 * 的連續換行收成一個空行。
 *
 * 縮排一定要去掉 —— `getSelection().toString()` 會把 HTML 原始碼的縮排一起
 * 帶出來,原樣送出去的話,Telegram 上每一行前面都會多一截空白。
 * 空行收斂則是因為區塊之間的空白節點會產生一串空行,看起來像內容中斷。
 */
export function richSelection(raw: string): string {
	return raw
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
