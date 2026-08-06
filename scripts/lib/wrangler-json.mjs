// 解析 `wrangler … --json` 的 stdout。
//
// 不能直接 JSON.parse:wrangler 會在 JSON 前面夾雜給人看的行,而且種類會變。
// 目前見過的有版本更新提示,以及 4.90 開始的
//
//   Cloudflare agent skills are available for: Claude Code, Cursor, …
//
// 後者讓 pnpm db:pull 掛在 "SyntaxError: Unexpected token 'C'" —— 一個跟真正
// 問題毫無關係的錯誤訊息。這種雜訊未來只會更多,所以剝除它應該是一個地方的事。
//
// 以「行」為單位找起點,而不是 indexOf('['):文案裡出現一個方括號就會讓
// 字元級的搜尋切在錯的地方,而 --json 的輸出必定從行首開始。

/**
 * @param {string} stdout wrangler 的原始 stdout
 * @param {string} what   出錯訊息裡用來指認呼叫端的字串
 * @returns {any} 解析後的 JSON
 * @throws 找不到 JSON 或解析失敗時,錯誤訊息帶上原始輸出
 */
export function parseWranglerJson(stdout, what = 'wrangler') {
  const lines = String(stdout).split('\n');
  const at = lines.findIndex((l) => {
    const t = l.trimStart();
    return t.startsWith('[') || t.startsWith('{');
  });

  if (at < 0) {
    throw new Error(
      `${what}: 輸出裡找不到 JSON。原始輸出:\n${stdout}`,
    );
  }

  const body = lines.slice(at).join('\n');
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(
      `${what}: JSON 解析失敗(${err.message})。原始輸出:\n${stdout}`,
    );
  }
}

/**
 * `wrangler d1 execute --json` 的常用形狀:取第一段查詢的 results。
 * 查無資料回空陣列;**但輸出不是 JSON 時會拋** —— 兩者不該長得一樣,
 * 否則「wrangler 壞了」會被誤讀成「資料庫是空的」。
 */
export function d1Rows(stdout, what = 'wrangler d1 execute') {
  const json = parseWranglerJson(stdout, what);
  return json?.[0]?.results ?? [];
}
