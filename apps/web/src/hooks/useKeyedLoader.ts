import { useCallback, useRef, useState } from 'react';
import { errorMessage } from '../errors';

type LoaderState<T> = { key: string | null; data: T | null; loading: boolean; error: string };

const EMPTY = { data: null, loading: false, error: '' };

/**
 * Caches one async load result per key: when the key changes the old data is invalidated immediately, and late old responses are discarded.
 * A null key means this data is not needed right now. load can be called repeatedly; the same key is requested only once, and can be retried after a failure.
 */
export function useKeyedLoader<T>(key: string | null, fetcher: () => Promise<T>) {
  const [state, setState] = useState<LoaderState<T>>({ key: null, ...EMPTY });
  const keyRef = useRef(key);
  keyRef.current = key;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async () => {
    const requested = keyRef.current;
    if (requested === null) return;
    const current = stateRef.current;
    if (current.key === requested && (current.loading || current.data !== null)) return;
    const pending: LoaderState<T> = { key: requested, data: null, loading: true, error: '' };
    // Write to the ref synchronously first, so calling load again within the same render does not send a second request.
    stateRef.current = pending;
    setState(pending);
    try {
      const data = await fetcherRef.current();
      if (keyRef.current === requested) setState({ key: requested, data, loading: false, error: '' });
    } catch (err) {
      if (keyRef.current === requested) {
        setState({ key: requested, data: null, loading: false, error: errorMessage(err) });
      }
    }
  }, []);

  const current = state.key === key ? state : EMPTY;
  return { data: current.data, loading: current.loading, error: current.error, load };
}
