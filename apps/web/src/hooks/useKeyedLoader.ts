import { useCallback, useRef, useState } from 'react';
import { errorMessage } from '../errors';

type LoaderState<T> = { key: string | null; data: T | null; loading: boolean; error: string };

const EMPTY = { data: null, loading: false, error: '' };

/**
 * 按 key 缓存一次异步加载结果：key 变化后旧数据立即失效，迟到的旧响应直接丢弃。
 * key 为 null 表示当前不需要这份数据。load 可重复调用，同一 key 只请求一次，失败后可重试。
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
    // 先同步写入 ref，避免同一轮渲染里重复调用 load 发出第二个请求。
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
