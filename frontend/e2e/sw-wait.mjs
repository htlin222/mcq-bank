// 讓 Service Worker 真的上線的那幾支 e2e 共用的等待。
//
// ⚠️ 不能用 `page.waitForFunction(async () => …)`:Playwright 不 await 述詞,
// Promise 本身是 truthy,第一次輪詢就放行。實測放行當下 `registration.active`
// 還是 undefined,而 CI 忙時 install(precache)可以超過 10 秒 —— 那段期間的
// 導覽全都不會被接管,症狀是「連換三頁都沒有 controller」。要等非同步的狀態,
// 用這裡的 `pollAsync`。

async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 等到這個 origin 的 SW 真的 `activated`。`registration.active` 在 `activating`
 *  時就有值(workbox precache 的 waitUntil 還沒完),那時換頁一樣不會被接管。 */
export function waitUntilSwActivated(page, ms = 60_000) {
  const activated = page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    const w = reg.active;
    if (w.state === 'activated') return;
    await new Promise((resolve) => {
      w.addEventListener('statechange', () => {
        if (w.state === 'activated') resolve();
      });
    });
  });
  return withTimeout(activated, ms, `SW ${ms / 1000} 秒內沒有 activated`);
}

/** 在頁面裡反覆跑一個 async 述詞,直到它回 truthy。 */
export async function pollAsync(page, fn, { timeout = 30_000, interval = 200, arg } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > deadline) throw new Error(`pollAsync ${timeout}ms 逾時`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
