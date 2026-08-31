import { useEffect } from 'react';
import {
  CHROME_HIDDEN_CLASS,
  CHROME_REVEAL_ABOVE,
  consumeProgrammaticScroll,
  nextChromeState,
  seedChrome,
} from '../lib/autoHideChrome.ts';

// 判定邏輯(方向、閾值、橡皮筋)在 lib/autoHideChrome.ts,那支不 import 任何東西
// 所以測得到。這裡只負責接事件、節流、寫 DOM。

/** 編輯中的欄位聚焦時強制顯示 —— 收合會把游標位置往上推,打字打到一半跳走最惱人。 */
function editingSomething(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  );
}

/**
 * @param enabled 由呼叫端決定(路由 opt-out)。false 時保證把 class 清掉 ——
 *   從 opt-out 路由離開時若殘留,新頁面會頂著一條收起來的 header。
 */
export function useAutoHideChrome(enabled: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    const clear = () => root.classList.remove(CHROME_HIDDEN_CLASS);

    if (!enabled) {
      clear();
      return clear;
    }

    // `md` 以上不做:右欄是自己的捲動容器(見 .substick 的 md 分支),window
    // scroll 量到的跟使用者實際在捲的不是同一個東西。
    const wide = window.matchMedia('(min-width: 768px)');
    // 收合是純粹的動態裝飾,關掉動畫的人不會想要它。
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

    // 以當下的位置起算 —— 從已經捲到一半的位置掛載時,不該自己收起來。
    let state = seedChrome(window.scrollY);
    let raf = 0;

    const measure = () => {
      raf = 0;
      // 還原捲動位置那一下不是使用者捲的 —— 當成重新掛載,以新位置起算。
      if (consumeProgrammaticScroll()) {
        state = seedChrome(window.scrollY);
        root.classList.remove(CHROME_HIDDEN_CLASS);
        return;
      }
      const next = nextChromeState(state, {
        y: window.scrollY,
        maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        revealAbove: CHROME_REVEAL_ABOVE,
        forceShow: wide.matches || calm.matches || editingSomething(),
      });
      if (next.hidden !== state.hidden) {
        root.classList.toggle(CHROME_HIDDEN_CLASS, next.hidden);
      }
      state = next;
    };

    // rAF 節流:慣性捲動每幀丟好幾個事件,而我們一幀最多只需要讀一次。
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // 聚焦/失焦不會產生 scroll 事件,但會改變 forceShow。
    window.addEventListener('focusin', onScroll);
    window.addEventListener('focusout', onScroll);
    wide.addEventListener('change', onScroll);
    calm.addEventListener('change', onScroll);
    measure();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('focusin', onScroll);
      window.removeEventListener('focusout', onScroll);
      wide.removeEventListener('change', onScroll);
      calm.removeEventListener('change', onScroll);
      clear();
    };
  }, [enabled]);
}

