import test from "node:test";
import assert from "node:assert/strict";
import { createAudioRecorder, MAX_RECORDING_BYTES } from "../src/features/recording/recorder.ts";

function fixture(requestOverride) {
  let events;
  let interval;
  let now = 0;
  const calls = { requested: 0, stopped: 0, disposed: 0, timerCleared: 0, revoked: [] };
  const source = {
    mimeType: "audio/webm;codecs=opus",
    start(next) { events = next; },
    stop() { calls.stopped++; },
    dispose() { calls.disposed++; },
  };
  const recorder = createAudioRecorder({
    requestMicrophone: () => { calls.requested++; return requestOverride ? requestOverride(source) : Promise.resolve(source); },
    createUrl: () => "blob:test-preview",
    revokeUrl: url => calls.revoked.push(url),
    now: () => now,
    everySecond: callback => { interval = callback; return () => { interval = undefined; calls.timerCleared++; }; },
  });
  return { recorder, source, calls, get events() { return events; }, tick(ms) { now += ms; interval?.(); } };
}

test("recording transitions through permission, recording and final-chunk preview", async () => {
  const f = fixture();
  const statuses = [];
  const unsubscribe = f.recorder.subscribe(() => statuses.push(f.recorder.getSnapshot().status));
  const pending = f.recorder.start();
  assert.equal(f.recorder.getSnapshot().status, "requesting");
  await pending;
  assert.equal(f.recorder.getSnapshot().status, "recording");
  f.tick(3000);
  assert.equal(f.recorder.getSnapshot().elapsedSeconds, 3);
  f.recorder.stop();
  assert.equal(f.recorder.getSnapshot().status, "stopping");
  f.events.data(new Blob(["final audio chunk"]));
  f.events.stop();
  const state = f.recorder.getSnapshot();
  assert.equal(state.status, "stopped");
  assert.equal(await state.blob.text(), "final audio chunk");
  assert.equal(state.blob.type, "audio/webm;codecs=opus");
  assert.equal(state.audioUrl, "blob:test-preview");
  assert.equal(f.calls.disposed, 1);
  assert.equal(f.calls.timerCleared, 1);
  assert.ok(statuses.includes("requesting") && statuses.includes("recording") && statuses.includes("stopping"));
  f.recorder.dispose();
  assert.deepEqual(f.calls.revoked, ["blob:test-preview"]);
  unsubscribe();
});

test("cancel during permission acquisition releases a late stream and ignores repeated starts", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture(() => pending);
  const started = f.recorder.start();
  await f.recorder.start();
  assert.equal(f.calls.requested, 1);
  f.recorder.cancel();
  resolve(f.source);
  await started;
  assert.equal(f.recorder.getSnapshot().status, "idle");
  assert.equal(f.calls.disposed, 1);
  assert.equal(f.events, undefined);
});

test("unmount cancels resources and stale media callbacks cannot resurrect preview", async () => {
  const f = fixture(); await f.recorder.start();
  const oldEvents = f.events;
  f.recorder.dispose();
  oldEvents.data(new Blob(["stale"])); oldEvents.stop(); oldEvents.error();
  assert.equal(f.recorder.getSnapshot().status, "idle");
  assert.equal(f.calls.disposed, 1);
  assert.equal(f.calls.timerCleared, 1);
  // React Strict Mode setup/cleanup/setup can safely reuse the controller.
  await f.recorder.start();
  assert.equal(f.recorder.getSnapshot().status, "recording");
  f.recorder.dispose();
});

test("permission denial, missing device, busy device and unsupported contexts are actionable", async () => {
  for (const [name, expected] of [["NotAllowedError", /denied/], ["NotFoundError", /No microphone/], ["NotReadableError", /unavailable/], ["NotSupportedError", /localhost or HTTPS/]]) {
    const f = fixture(() => Promise.reject(new DOMException("private browser details", name)));
    await f.recorder.start();
    const state = f.recorder.getSnapshot();
    assert.equal(state.status, "error");
    assert.match(state.message, expected);
    assert.ok(!state.message.includes("private"));
  }
});

test("empty, interrupted and oversized recordings never become usable previews", async () => {
  for (const kind of ["empty", "error", "large"]) {
    const f = fixture(); await f.recorder.start();
    if (kind === "empty") { f.recorder.stop(); f.events.stop(); }
    if (kind === "error") f.events.error();
    if (kind === "large") f.events.data(new Blob([new Uint8Array(MAX_RECORDING_BYTES + 1)]));
    assert.equal(f.recorder.getSnapshot().status, "error");
    assert.equal(f.calls.disposed, 1);
    assert.equal(f.calls.timerCleared, 1);
  }
});

test("two-minute cap requests stop and record-again revokes the old preview", async () => {
  const f = fixture(); await f.recorder.start();
  f.tick(120000);
  assert.equal(f.recorder.getSnapshot().status, "stopping");
  assert.equal(f.calls.stopped, 1);
  f.events.data(new Blob(["audio"])); f.events.stop();
  assert.equal(f.recorder.getSnapshot().elapsedSeconds, 120);
  await f.recorder.start();
  assert.deepEqual(f.calls.revoked, ["blob:test-preview"]);
  assert.equal(f.recorder.getSnapshot().status, "recording");
  f.recorder.dispose();
});
