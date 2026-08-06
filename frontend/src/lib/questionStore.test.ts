import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionStore } from './questionStore.ts';

/** A fetcher whose resolution we control, so we can observe in-flight state. */
function deferredFetcher() {
  const calls: string[] = [];
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const fetcher = (id: string) =>
    new Promise<any>((resolve, reject) => {
      calls.push(id);
      pending.set(id, { resolve, reject });
    });
  return { fetcher, calls, pending };
}

test('peek 對未知 id 回 undefined,不觸發抓取', () => {
  const { fetcher, calls } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  assert.equal(store.peek('114-001'), undefined);
  assert.deepEqual(calls, []);
});

test('get 抓一次之後 peek 就同步拿得到 —— 這是「換題零 loading」的基礎', async () => {
  const { fetcher, calls, pending } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  const p = store.get('114-001');
  pending.get('114-001')!.resolve({ id: '114-001' });
  assert.deepEqual(await p, { id: '114-001' });
  assert.deepEqual(store.peek('114-001'), { id: '114-001' });
  assert.deepEqual(calls, ['114-001']);
});

test('同一 id 併發 get 只打一次網路(in-flight 去重)', async () => {
  const { fetcher, calls, pending } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  const a = store.get('114-001');
  const b = store.get('114-001');
  assert.deepEqual(calls, ['114-001']);
  pending.get('114-001')!.resolve({ id: '114-001' });
  assert.deepEqual(await a, await b);
});

test('prefetch 之後 get 不再打網路 —— 預抓命中', async () => {
  const { fetcher, calls, pending } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  store.prefetch('114-002');
  pending.get('114-002')!.resolve({ id: '114-002' });
  await store.inflight('114-002');
  assert.deepEqual(store.peek('114-002'), { id: '114-002' });
  await store.get('114-002');
  assert.deepEqual(calls, ['114-002']);
});

test('prefetch 失敗只是沒命中,不會丟出未捕捉的 rejection', async () => {
  const { fetcher, pending } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  store.prefetch('114-003');
  pending.get('114-003')!.reject(new Error('boom'));
  await store.inflight('114-003');
  assert.equal(store.peek('114-003'), undefined);
});

test('get 失敗不會毒化快取,下一次會重試', async () => {
  const { fetcher, calls, pending } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  const first = store.get('114-004');
  pending.get('114-004')!.reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  const second = store.get('114-004');
  assert.deepEqual(calls, ['114-004', '114-004']);
  pending.get('114-004')!.resolve({ id: '114-004' });
  assert.deepEqual(await second, { id: '114-004' });
});

test('set 直接寫入(存檔後把新版塞回,免得下一次換題讀到舊的)', () => {
  const { fetcher, calls } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  store.set('114-005', { id: '114-005', v: 2 });
  assert.deepEqual(store.peek('114-005'), { id: '114-005', v: 2 });
  assert.deepEqual(calls, []);
});

test('invalidate 只丟掉那一題;clear 全丟', () => {
  const { fetcher } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  store.set('a', 1);
  store.set('b', 2);
  store.invalidate('a');
  assert.equal(store.peek('a'), undefined);
  assert.equal(store.peek('b'), 2);
  store.clear();
  assert.equal(store.peek('b'), undefined);
});

test('超過 max 時淘汰最久沒被碰過的那筆(LRU,不是先進先出)', () => {
  const { fetcher } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher, { max: 3 });
  store.set('a', 1);
  store.set('b', 2);
  store.set('c', 3);
  store.peek('a'); // a 剛被讀過 → 最新
  store.set('d', 4); // 該淘汰的是 b
  assert.equal(store.peek('b'), undefined);
  assert.equal(store.peek('a'), 1);
  assert.equal(store.peek('c'), 3);
  assert.equal(store.peek('d'), 4);
  assert.equal(store.size(), 3);
});

test('過了 ttl 仍然 peek 得到(stale-while-revalidate),但 isFresh 為 false', () => {
  const { fetcher } = deferredFetcher();
  let now = 1000;
  const store = createQuestionStore<any>(fetcher, { ttlMs: 100, now: () => now });
  store.set('a', 1);
  assert.equal(store.isFresh('a'), true);
  now = 1101;
  assert.equal(store.peek('a'), 1, '陳舊資料照樣先給,畫面才不會空白');
  assert.equal(store.isFresh('a'), false, '但要標記成需要背景重抓');
});

test('isFresh 對沒快取的 id 回 false', () => {
  const { fetcher } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  assert.equal(store.isFresh('nope'), false);
});

test('新鮮的 id 再 prefetch 不會多打網路', async () => {
  const { fetcher, calls } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher, { ttlMs: 10_000 });
  store.set('a', 1);
  store.prefetch('a');
  assert.deepEqual(calls, []);
});

test('prefetch(undefined) 是安全的 no-op —— 首題沒有上一題', () => {
  const { fetcher, calls } = deferredFetcher();
  const store = createQuestionStore<any>(fetcher);
  store.prefetch(undefined);
  store.prefetch('');
  assert.deepEqual(calls, []);
});
