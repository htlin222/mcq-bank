import { useEffect, useRef, useState, useCallback } from 'react';
import { api, ApiError } from '../lib/api';

type LockState =
  | { status: 'idle' }
  | { status: 'acquiring' }
  | { status: 'held'; until: number }
  | { status: 'locked-by-other'; lockedBy: string; until: number }
  | { status: 'error'; message: string };

const RENEW_INTERVAL_MS = 60_000; // server TTL is 5 min; renew every 60s

/**
 * Pessimistic lock for explanation editing.
 *  - acquire(): try to take the lock
 *  - release(): give it up (auto-called on unmount when held)
 *  - while held, renew every 60s
 */
export function useLock(questionId: string) {
  const [state, setState] = useState<LockState>({ status: 'idle' });
  const renewTimer = useRef<number | null>(null);
  const heldRef = useRef(false);

  const stopRenew = useCallback(() => {
    if (renewTimer.current !== null) {
      window.clearInterval(renewTimer.current);
      renewTimer.current = null;
    }
  }, []);

  const acquire = useCallback(async () => {
    setState({ status: 'acquiring' });
    try {
      const res = await api.post<{ ok: true; until: number }>(
        `/api/questions/${questionId}/explanation/lock`,
      );
      heldRef.current = true;
      setState({ status: 'held', until: res.until });

      stopRenew();
      renewTimer.current = window.setInterval(async () => {
        try {
          const r = await api.post<{ ok: true; until: number }>(
            `/api/questions/${questionId}/explanation/lock`,
          );
          setState({ status: 'held', until: r.until });
        } catch (e) {
          // lost the lock
          heldRef.current = false;
          stopRenew();
          if (e instanceof ApiError && e.status === 423) {
            setState({
              status: 'locked-by-other',
              lockedBy: e.data?.locked_by ?? 'unknown',
              until: e.data?.until ?? 0,
            });
          } else {
            setState({ status: 'error', message: String(e) });
          }
        }
      }, RENEW_INTERVAL_MS);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) {
        setState({
          status: 'locked-by-other',
          lockedBy: e.data?.locked_by ?? 'unknown',
          until: e.data?.until ?? 0,
        });
      } else {
        setState({ status: 'error', message: String(e) });
      }
      return false;
    }
  }, [questionId, stopRenew]);

  const release = useCallback(async () => {
    stopRenew();
    if (!heldRef.current) return;
    heldRef.current = false;
    try {
      await api.post(`/api/questions/${questionId}/explanation/unlock`);
    } catch {
      // best effort
    }
    setState({ status: 'idle' });
  }, [questionId, stopRenew]);

  // Release on unmount + page hide (mobile users switching apps)
  useEffect(() => {
    const onHide = () => {
      if (heldRef.current) {
        // beacon doesn't carry credentials reliably; just stop renewing.
        // The 5-min server TTL will clean up.
        stopRenew();
      }
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      stopRenew();
      if (heldRef.current) {
        // fire-and-forget
        api.post(`/api/questions/${questionId}/explanation/unlock`).catch(() => {});
      }
    };
  }, [questionId, stopRenew]);

  return { state, acquire, release };
}
