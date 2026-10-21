"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api/client";
import { useAudioRecorder } from "@/features/recording/hooks/use-audio-recorder";
import { createSalesFlow, EMPTY_FLOW } from "../sales-flow";

type Session = { recorder: ReturnType<typeof useAudioRecorder>; flow: ReturnType<typeof createSalesFlow>; state: ReturnType<ReturnType<typeof createSalesFlow>["getSnapshot"]> };
const Context = createContext<Session | null>(null);
const STORAGE_KEY = "tova.sales-draft.v1";
export function SalesSession({ children }: { children: ReactNode }) {
  const recorder = useAudioRecorder();
  const pathname = usePathname();
  const [flow] = useState(() => createSalesFlow(api, {
    read: () => sessionStorage.getItem(STORAGE_KEY),
    write: value => { if (value === null) sessionStorage.removeItem(STORAGE_KEY); else sessionStorage.setItem(STORAGE_KEY, value); },
  }, () => window.dispatchEvent(new Event("tova:sales-updated"))));
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot, () => EMPTY_FLOW);
  useEffect(() => { flow.restore(); }, [flow]);
  const { stop } = recorder;
  const { cancel } = recorder;
  useEffect(() => { if (state.phase === "saved") cancel(); }, [state.phase, cancel]);
  useEffect(() => { if (pathname !== "/record" && recorder.state.status === "recording") stop(); }, [pathname, recorder.state.status, stop]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (state.phase !== "saved" && (state.transcript || recorder.state.status !== "idle")) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.phase, state.transcript, recorder.state.status]);
  return <Context.Provider value={{ recorder, flow, state }}>{children}</Context.Provider>;
}
export function useSalesSession() {
  const session = useContext(Context);
  if (!session) throw new Error("SalesSession is required.");
  return session;
}
export function ResumeSale() {
  const { state, recorder } = useSalesSession();
  if (state.phase === "saved" || (!state.transcript && recorder.state.status !== "stopped")) return null;
  return <p className="resume-sale">You have an unfinished sale. <Link href={state.draft ? "/review" : "/record"}>Continue where you left off →</Link></p>;
}
