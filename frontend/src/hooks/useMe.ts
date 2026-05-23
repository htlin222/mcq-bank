import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export type Me = {
  email: string;
  display_name: string;
  avatar_key: string | null;
  bio: string | null;
  created_at: number;
};

let cached: Me | null = null;
const listeners = new Set<(m: Me) => void>();

export function useMe() {
  const [me, setMe] = useState<Me | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    api
      .get<Me>('/api/me')
      .then((m) => {
        if (cancelled) return;
        cached = m;
        setMe(m);
        listeners.forEach((fn) => fn(m));
      })
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    listeners.add(setMe);
    return () => {
      listeners.delete(setMe);
    };
  }, []);

  async function update(patch: Partial<Pick<Me, 'display_name' | 'bio' | 'avatar_key'>>) {
    const updated = await api.patch<Me>('/api/me', patch);
    cached = updated;
    listeners.forEach((fn) => fn(updated));
    return updated;
  }

  return { me, loading, error, update };
}
