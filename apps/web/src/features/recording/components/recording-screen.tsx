"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Card, PageHeader } from "@/components/ui/presentation";
import { useSalesSession } from "@/features/sales/components/sales-session";

function timerLabel(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function RecordingScreen() {
  const { recorder: { state, start, stop, cancel }, flow, state: saleFlow } = useSalesSession();
  const router = useRouter();
  const processing = saleFlow.phase === "transcribing" || saleFlow.phase === "extracting";
  const locked = processing || saleFlow.phase === "saving" || saleFlow.phase === "save-error";
  const ready = state.status === "stopped" && state.blob.size > 0;
  const canProcess = ready || !!saleFlow.transcript;
  const active = state.status === "recording";
  const busy = state.status === "requesting" || state.status === "stopping" || locked;
  const reset = () => {
    if (locked) return false;
    if (saleFlow.transcript && saleFlow.phase !== "saved" && !window.confirm("Discard this unsaved sale and recording?")) return false;
    if (!flow.reset()) return false;
    cancel(); return true;
  };
  const begin = () => { if (reset()) void start(); };
  const proceed = async () => {
    if (state.status !== "stopped" && !saleFlow.transcript) return;
    await flow.process(state.status === "stopped" ? state.blob : new Blob());
    if (flow.getSnapshot().phase === "review") router.push("/review");
  };
  const status = { idle: "Ready when you are", requesting: "Waiting for microphone access…", recording: "Recording your sale", stopping: "Preparing your recording…", stopped: "Your recording is ready", error: "Let’s try that again" }[state.status];

  return <>
    <PageHeader eyebrow="ONE SALE. YOUR OWN WORDS." title="Record a sale"><p>Tell us what you sold. We&apos;ll take it one step at a time.</p></PageHeader>
    <div className="recording-layout">
      <Card className={`recorder ${active ? "recorder--active" : ""}`}>
        <div className="recorder-topline"><span className="eyebrow">Voice note</span><span className="duration-limit">Up to 2 minutes</span></div>
        <div className="recorder-status" role="status"><span className={`status-dot ${active ? "status-dot--live" : ""}`} />{status}</div>
        <IconButton label={active ? "Stop recording" : ready ? "Record again" : "Start recording"} className="microphone-control" disabled={busy} onClick={active ? stop : begin}><Icon name={active ? "stop" : "mic"} width="40" height="40" /></IconButton>
        <p className="recording-timer" role="timer" aria-label={`Recording duration ${timerLabel(state.elapsedSeconds)}`}>{timerLabel(state.elapsedSeconds)}</p>
        <p className="recorder-hint">{active ? "Take your time. Speak as you normally would." : ready ? "Listen back before moving on." : "A quiet spot and a clear voice are all you need."}</p>
        {state.status === "error" && <p className="feedback feedback--error" role="alert">{state.message}</p>}
        {state.status === "stopped" && <div className="audio-preview"><audio key={state.audioUrl} controls src={state.audioUrl} aria-label="Preview your recorded sale" preload="metadata" /><span className="preview-note">Audio preview · Continue sends audio for transcription</span></div>}
        <div className="recorder-actions">
          {ready ? <Button variant="secondary" onClick={begin} disabled={locked}><Icon name="refresh" />Record again</Button> : <Button loading={busy} onClick={active ? stop : begin}>{active ? "Stop recording" : state.status === "requesting" ? "Allow microphone" : state.status === "stopping" ? "Preparing audio" : "Start recording"}</Button>}
          <Button variant="ghost" onClick={reset} disabled={(state.status === "idle" && !saleFlow.transcript) || locked}>Cancel</Button>
        </div>
        <div className="continue-row"><Button disabled={!canProcess || locked || saleFlow.phase === "review" || saleFlow.phase === "saved"} loading={processing} onClick={() => void proceed()}>{saleFlow.phase === "transcribing" ? "Transcribing..." : saleFlow.phase === "extracting" ? "Preparing your draft..." : "Continue"}<Icon name="arrow" /></Button></div>
        {saleFlow.phase === "error" && <p className="feedback feedback--error" role="alert">{saleFlow.error} {ready ? "Your recording is still available." : saleFlow.transcript ? "Your transcript is retained." : "Please record again."} Select Continue to retry.</p>}
        {(saleFlow.phase === "review" || saleFlow.phase === "save-error") && <p className="feedback"><Link href="/review" className="text-link">Return to your unsaved sale <Icon name="arrow" /></Link></p>}
      </Card>
      <aside className="recording-guide" aria-labelledby="recording-guide-title"><span className="guide-number">A SMALL TIP</span><h2 id="recording-guide-title">Just say it<br /><em>like you sold it.</em></h2><p>Mention the item, quantity, selling unit, and price per unit.</p><blockquote>“I sold two dozen gowns at twenty-four thousand naira per dozen.”</blockquote><p className="guide-note">A dozen stays a dozen. A piece stays a piece.</p><div className="privacy-note"><Icon name="mic" width="18" height="18" /><p>Your microphone is only on while recording. Your preview stays available as you move around Tova. Refreshing discards audio; unsaved draft edits stay in this tab.</p></div></aside>
    </div>
  </>;
}
