export type RecorderState =
  | { status: "idle" | "requesting" | "recording" | "stopping"; elapsedSeconds: number }
  | { status: "stopped"; elapsedSeconds: number; blob: Blob; audioUrl: string }
  | { status: "error"; elapsedSeconds: number; message: string };

export type RecordingSource = {
  mimeType: string;
  start: (events: { data: (blob: Blob) => void; stop: () => void; error: () => void }) => void;
  stop: () => void;
  dispose: () => void;
};
export type RecorderEnvironment = {
  requestMicrophone: () => Promise<RecordingSource>;
  createUrl: (blob: Blob) => string;
  revokeUrl: (url: string) => void;
  now: () => number;
  everySecond: (callback: () => void) => () => void;
};
export const MAX_RECORDING_SECONDS = 120;
export const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
export const INITIAL_STATE: RecorderState = { status: "idle", elapsedSeconds: 0 };

function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied. Allow microphone access in your browser settings, then try again.";
  if (name === "NotFoundError") return "No microphone was found. Connect a microphone and try again.";
  if (name === "NotReadableError") return "Your microphone is unavailable. Close other apps using it and try again.";
  if (name === "NotSupportedError") return "This browser cannot record audio here. Try a current browser on localhost or HTTPS.";
  return "We couldn’t start the microphone. Check your device and try again.";
}

// A local lifecycle store lets the hook subscribe while media races and cleanup
// can be tested without adding a React testing framework.
export function createAudioRecorder(environment: RecorderEnvironment) {
  let state: RecorderState = INITIAL_STATE;
  const listeners = new Set<() => void>();
  let generation = 0;
  let source: RecordingSource | undefined;
  let clearTimer: (() => void) | undefined;
  let url: string | undefined;
  let chunks: Blob[] = [];
  let bytes = 0;
  let startedAt = 0;

  function publish(next: RecorderState) { state = next; listeners.forEach(listener => listener()); }
  function release() {
    clearTimer?.(); clearTimer = undefined;
    const previous = source; source = undefined;
    previous?.dispose();
    chunks = []; bytes = 0;
    if (url) environment.revokeUrl(url);
    url = undefined;
  }
  function fail(message: string) {
    generation++;
    release();
    publish({ status: "error", elapsedSeconds: 0, message });
  }
  function cancel() {
    generation++;
    release();
    publish(INITIAL_STATE);
  }
  function stop() {
    if (state.status !== "recording" || !source) return;
    clearTimer?.(); clearTimer = undefined;
    const elapsedSeconds = Math.min(MAX_RECORDING_SECONDS, Math.floor((environment.now() - startedAt) / 1000));
    publish({ status: "stopping", elapsedSeconds });
    try { source.stop(); } catch { fail("The recording could not be finished. Please record it again."); }
  }
  async function start() {
    if (["requesting", "recording", "stopping"].includes(state.status)) return;
    cancel();
    const current = generation;
    publish({ status: "requesting", elapsedSeconds: 0 });
    try {
      const acquired = await environment.requestMicrophone();
      if (current !== generation) { acquired.dispose(); return; }
      source = acquired;
      startedAt = environment.now();
      publish({ status: "recording", elapsedSeconds: 0 });
      acquired.start({
        data: blob => {
          if (current !== generation || !blob.size) return;
          bytes += blob.size;
          if (bytes > MAX_RECORDING_BYTES) { fail("This recording is too large. Try a shorter recording."); return; }
          chunks.push(blob);
        },
        stop: () => {
          if (current !== generation) return;
          const elapsedSeconds = Math.min(MAX_RECORDING_SECONDS, Math.floor((environment.now() - startedAt) / 1000));
          const blob = new Blob(chunks, { type: acquired.mimeType || chunks[0]?.type || "audio/webm" });
          release();
          if (!blob.size) { fail("No audio was captured. Please try recording again."); return; }
          try {
            url = environment.createUrl(blob);
            publish({ status: "stopped", elapsedSeconds, blob, audioUrl: url });
          } catch { fail("We couldn’t prepare your audio preview. Please record again."); }
        },
        error: () => { if (current === generation) fail("The microphone was interrupted. Please record again."); },
      });
      if (current === generation && state.status === "recording") {
        clearTimer = environment.everySecond(() => {
          const elapsedSeconds = Math.min(MAX_RECORDING_SECONDS, Math.floor((environment.now() - startedAt) / 1000));
          if (state.status !== "recording") return;
          publish({ status: "recording", elapsedSeconds });
          if (elapsedSeconds >= MAX_RECORDING_SECONDS) stop();
        });
      }
    } catch (error) { if (current === generation) fail(microphoneError(error)); }
  }
  return {
    start, stop, cancel,
    dispose: cancel,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const browserRecorderEnvironment: RecorderEnvironment = {
  async requestMicrophone() {
    if (typeof window === "undefined" || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new DOMException("Recording unavailable", "NotSupportedError");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      let detach = () => {};
      return {
        mimeType: recorder.mimeType,
        start(events) {
          const data = (event: BlobEvent) => events.data(event.data);
          const stop = () => events.stop();
          const error = () => events.error();
          recorder.addEventListener("dataavailable", data);
          recorder.addEventListener("stop", stop);
          recorder.addEventListener("error", error);
          stream.getTracks().forEach(track => track.addEventListener("ended", error));
          detach = () => {
            recorder.removeEventListener("dataavailable", data);
            recorder.removeEventListener("stop", stop);
            recorder.removeEventListener("error", error);
            stream.getTracks().forEach(track => track.removeEventListener("ended", error));
          };
          recorder.start(250);
        },
        stop() {
          // stop queues the final dataavailable before the stop event.
          if (recorder.state !== "inactive") recorder.stop();
          stream.getTracks().forEach(track => track.stop());
        },
        dispose() {
          detach();
          try { if (recorder.state !== "inactive") recorder.stop(); }
          finally { stream.getTracks().forEach(track => track.stop()); }
        },
      };
    } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
  },
  createUrl: blob => URL.createObjectURL(blob),
  revokeUrl: url => URL.revokeObjectURL(url),
  now: () => Date.now(),
  everySecond: callback => { const timer = setInterval(callback, 1000); return () => clearInterval(timer); },
};
