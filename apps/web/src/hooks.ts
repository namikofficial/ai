import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkbenchStore } from "./store.ts";

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh(): void;
}

export function useResource<T>(loader: () => Promise<T>, deps: ReadonlyArray<unknown> = [], options?: { live?: boolean }): ResourceState<T> {
  const liveTick = useWorkbenchStore((state) => state.liveTick);
  const refreshNonce = useWorkbenchStore((state) => state.refreshNonce);
  const [reloadTick, setReloadTick] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  const controllerRef = useRef<AbortController | null>(null);
  loaderRef.current = loader;
  const refresh = useCallback(() => setReloadTick((value) => value + 1), []);

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    loaderRef.current()
      .then((value) => {
        if (active) {
          setData(value);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (active && !(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
      controllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.live ? liveTick : 0, refreshNonce, reloadTick, ...deps]);

  return { data, loading, error, refresh };
}

/**
 * Simple query hook with abort controller support.
 * Replaces useResource for read operations.
 */
export function useApiQuery<T>(
  loader: () => Promise<{ status: "ok"; data: T }>,
  options?: { enabled?: boolean }
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadCountRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(() => {
    reloadCountRef.current += 1;
  }, []);

  useEffect(() => {
    if (options?.enabled === false) return;

    controllerRef.current?.abort();
    controllerRef.current = new AbortController();
    let active = true;
    const currentReload = reloadCountRef.current;

    setLoading(true);
    setError(null);

    loaderRef
      .current()
      .then((res) => {
        if (active && currentReload === reloadCountRef.current) {
          setData(res.data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active && currentReload === reloadCountRef.current && !(err instanceof DOMException && err.name === "AbortError")) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => {
      active = false;
      controllerRef.current?.abort();
    };
  }, [options?.enabled]);

  return { data, loading, error, reload };
}

/**
 * Mutation hook for write operations with loading/error state.
 */
export function useApiMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<{ status: "ok"; data: TOutput }>
): {
  mutate: (input: TInput) => Promise<TOutput>;
  loading: boolean;
  error: string | null;
  data: TOutput | null;
  reset: () => void;
} {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TOutput | null>(null);

  const mutate = useCallback(
    async (input: TInput): Promise<TOutput> => {
      setLoading(true);
      setError(null);
      try {
        const result = await mutationFn(input);
        setData(result.data);
        return result.data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [mutationFn]
  );

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setData(null);
  }, []);

  return { mutate, loading, error, data, reset };
}

/**
 * Task action helper - uses raw fetch since API client doesn't have these methods.
 * Returns the raw response ok status.
 */
export async function executeTaskAction(
  taskId: string,
  action: "start" | "complete" | "fail",
  body?: { result?: string; error?: string }
): Promise<boolean> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return response.ok;
}
