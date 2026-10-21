"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api/client";

function useRemote<T>(load: () => Promise<T>) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null; loader: () => Promise<T> }>({ data: null, loading: true, error: null, loader: load });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => { setState(previous => ({ ...previous, loading: true, error: null })); setRevision(value => value + 1); }, []);
  useEffect(() => {
    let active = true;
    load().then(data => { if (active) setState({ data, loading: false, error: null, loader: load }); }, error => { if (active) setState(previous => ({ ...previous, loading: false, loader: load, error: error instanceof Error ? error.message : "Unable to load sales." })); });
    return () => { active = false; };
  }, [load, revision]);
  useEffect(() => {
    window.addEventListener("tova:sales-updated", reload);
    window.addEventListener("focus", reload);
    const interval = setInterval(reload, 60_000);
    return () => { window.removeEventListener("tova:sales-updated", reload); window.removeEventListener("focus", reload); clearInterval(interval); };
  }, [reload]);
  return { ...state, loading: state.loading || state.loader !== load, reload };
}
export function useSalesList(limit: number, cursor?: string) {
  return useRemote(useCallback(() => api.sales(cursor, limit), [cursor, limit]));
}
export function useSalesSummary() { return useRemote(useCallback(() => api.summary(), [])); }
