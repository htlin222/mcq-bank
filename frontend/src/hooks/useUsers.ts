import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export type UserLite = {
  email: string;
  display_name: string;
  avatar_key: string | null;
};

let cached: UserLite[] | null = null;

export function useUsers() {
  const [users, setUsers] = useState<UserLite[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    api
      .get<UserLite[]>('/api/users')
      .then((u) => {
        if (cancelled) return;
        cached = u;
        setUsers(u);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return { users, loading };
}
