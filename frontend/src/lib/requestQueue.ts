// 同時在飛的請求上限。
//
// 成績頁的「展開全部選項」會讓幾十個(最多 100 個)展開區同時打開,而每一個打開
// 時都要抓一次選項分布 —— 逐題懶載入本來就是為了避免「一進頁面就 100 個 request」
// (見 ExamResult 的 AnswerDetail 註解),一顆全部展開的按鈕會把那件事整個做回來,
// 只是改成一次爆發。
//
// **瀏覽器那條「同一個 origin 最多 6 條連線」的天然上限在這裡不存在** —— HTTP/2
// 是多工的,100 個 fetch 就是 100 個同時在飛。所以自己排隊。
//
// 這裡不減少請求**總數**(那是逐題懶載入的另一面:沒展開的題目一次都不抓),
// 只把爆發攤平。要真的把總數壓下來得開批次端點,而那要複製一份組 payload 的
// 程式碼 —— 同 offline-year 那節不開 /bulk 的理由。

export type Gate = <T>(job: () => Promise<T>) => Promise<T>;

/**
 * 造一個閘門:同時執行的 job 不超過 `limit` 個,其餘排隊。
 *
 * 回傳的 promise 跟著 job 走(成功/失敗都照原樣傳出去)—— 失敗被吃掉的話,
 * 呼叫端的錯誤處理(那一題顯示「分布載入失敗」)就永遠不會跑到。
 */
export function createGate(limit: number): Gate {
  const max = Math.max(1, limit);
  const queue: (() => void)[] = [];
  let inFlight = 0;

  const pump = () => {
    // while 不是 if:一個 job 結束時可能剛好有多個空位(limit 被調大不會發生,
    // 但排隊中的 job 同步 resolve 時會)。
    while (inFlight < max && queue.length > 0) queue.shift()!();
  };

  return <T>(job: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        inFlight++;
        // job() 本身丟同步例外時也要放掉位子,否則閘門會慢慢鎖死。
        let p: Promise<T>;
        try {
          p = job();
        } catch (e) {
          inFlight--;
          pump();
          reject(e);
          return;
        }
        p.then(resolve, reject).finally(() => {
          inFlight--;
          pump();
        });
      };
      queue.push(start);
      pump();
    });
}
