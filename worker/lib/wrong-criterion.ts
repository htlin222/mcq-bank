// 「錯題」是什麼:**最近一次作答答錯的題目**。
//
// 這個判準原本在三個地方各寫了一份(清單 `/api/review/wrong`、匯出
// `export-scope.ts`、出卷精靈 `testBuilder.ts`),兩份還各留了一行註解說自己
// 「對齊」另一份 —— 註解擋不住漂移,而漂移的症狀是「清單上有 74 題,匯出來 76 題」
// 這種沒有人會回報的差異。所以改成一份定義、三處 import。
//
// **舊判準是「累積正確率 < 100%」,而它有一個沒說出口的後果:一旦答錯過一次,
// `times_correct < times_seen` 就永遠成立 —— 那一題永遠留在錯題清單裡,再怎麼練
// 都不會離開。** 使用者回報的「全真答對了為什麼還在錯題」就是這件事:模擬考的
// 「登記進複習進度」只寫 `last_chosen` / `last_correct`,依設計不動累積次數
// (見 `apply-exam-to-review.ts`),所以錯誤率一動也不動。
//
// 換成 `last_correct = 0` 之後:複習模式答對、或模擬考答對後按「登記進複習進度」,
// 那一題就離開清單。清單因此回答「我現在還不會哪些」,而不是「我曾經錯過哪些」——
// 後者的資訊仍然在(`times_correct` / `times_seen` 照樣顯示,也照樣可以拿來排序)。
//
// **NULL 的處理是刻意的:`= 0` 不會把 `last_correct IS NULL` 的列算進來。** 那種列
// 只可能來自「有 times_seen 卻沒寫過 last_correct」的遠古資料,而 2026-08-30 對
// 正式機的鏡像量過:1430 列全部有值,一列 NULL 都沒有。把「沒有紀錄」說成「最近
// 一次答錯」是說謊,而它現在也沒有實際影響。

/**
 * WHERE 片段。呼叫端的 `review_progress` 必須別名為 `rp`。
 *
 * LEFT JOIN 的情境(出卷精靈)下 `rp.*` 會是 NULL,兩個比較都不成立 —— 沒作答過的
 * 題目自然不算錯題,不必另外處理。
 */
export const WRONG_WHERE = "rp.times_seen > 0 AND rp.last_correct = 0";

/** 同一個判準,包成一顆可以直接塞進 OR/AND 串的括號(出卷精靈的 STATUS_SQL 用)。 */
export const WRONG_PREDICATE = `(${WRONG_WHERE})`;
