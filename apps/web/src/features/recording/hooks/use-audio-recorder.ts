"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { browserRecorderEnvironment, createAudioRecorder, INITIAL_STATE } from "../recorder";

export function useAudioRecorder() {
  const [recorder] = useState(() => createAudioRecorder(browserRecorderEnvironment));
  const state = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, () => INITIAL_STATE);
  useEffect(() => {
    // Release the microphone when leaving the page or backgrounding the app.
    const onPageHide = () => recorder.cancel();
    const onVisibility = () => { if (document.hidden && ["requesting", "recording", "stopping"].includes(recorder.getSnapshot().status)) recorder.cancel(); };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      recorder.dispose();
    };
  }, [recorder]);
  return { state, start: recorder.start, stop: recorder.stop, cancel: recorder.cancel };
}
