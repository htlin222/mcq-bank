// 登出與本機狀態重置。
//
// 這個 app 沒有自己的 session — 身分由 Cloudflare Access 持有,所以「登出」就是
// 把 Access 的 cookie 丟掉 (`/cdn-cgi/access/logout`),沒有 app 層的 session
// 可以殺。真正需要一起處理的是這台裝置留下的快取:一份過期的 Service Worker
// precache 會讓 app 在一般視窗裡看起來壞掉,而無痕視窗一切正常 —— 因為無痕沒有
// 那個 worker。所以兩個動作都先清快取。

const ACCESS_LOGOUT = '/cdn-cgi/access/logout';

// 註銷 Service Worker 並倒掉所有 Cache Storage。先註銷 worker:還活著的 worker
// 會在我們清完之後又把快取寫回去。
export async function clearLocalCaches(): Promise<void> {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* 不支援或被封鎖 — 沒有 worker 可註銷 */
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* Cache Storage 在非安全來源下不存在 */
  }
}

// 「清快取並重新載入」— 不動登入狀態,只把卡住的舊資產丟掉。
export async function reloadFresh(): Promise<void> {
  await clearLocalCaches();
  location.reload();
}

export async function signOut(): Promise<void> {
  await clearLocalCaches();
  // 畫記/考試標記都是即時寫到 server 的,清掉本機副本不會遺失任何下次登入
  // 拿不回來的東西。
  try {
    localStorage.clear();
  } catch {
    /* quota/unavailable */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* 同上 */
  }
  // 本地開發前面沒有 Access(CF_ACCESS_TEAM_DOMAIN=localhost 是 bypass),
  // logout endpoint 不存在,直接回首頁。
  location.href = location.hostname === 'localhost' ? '/' : ACCESS_LOGOUT;
}
