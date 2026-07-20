import { useEffect, useState } from 'react';

/**
 * Live connectivity flag, from `navigator.onLine` plus the online/offline
 * events.
 *
 * Caveat worth knowing before you trust it for anything but UI affordances:
 * `navigator.onLine === true` only means the device has *a* network
 * interface — a captive portal or a dead uplink still reads as online. False
 * is reliable, true is a hint. That is exactly why the offline story is
 * read-only: we disable write UI when we know we are offline, and let the
 * normal error path handle the cases we cannot detect.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return online;
}
