import { useCallback, useEffect, useRef, useState } from 'react';
import { VpnSnapshot } from '../../types/corporateVpn';

export function useVpnSnapshot() {
  const [snapshot, setSnapshot] = useState<VpnSnapshot>({
    profiles: [],
    state: { state: 'idle', generation: 0 },
    encryptionAvailable: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const live = useRef(true);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    const next = await window.electronAPI.corporateVpn.snapshot();
    if (live.current && version === sequence.current) {
      setSnapshot(next);
      setLoading(false);
      setError('');
    }
    return next;
  }, []);
  useEffect(() => {
    live.current = true;
    // Subscribe before reading the initial snapshot. Keep the aggregate and
    // per-profile states together so badges, counts and buttons agree.
    const off = window.electronAPI.corporateVpn.onState(() => {
      refresh().catch(() => {});
    });
    refresh().catch((e) => {
      if (live.current) {
        setLoading(false);
        setError(String(e));
      }
    });
    return () => {
      live.current = false;
      sequence.current++;
      off();
    };
  }, [refresh]);
  return { snapshot, loading, error, refresh };
}
