"use client";
import { useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from "@google/genai";

export type ToolCall =
  | { name: "goto_section"; args: { section_id: string } }
  | { name: "highlight_visual"; args: { visual_id: string } }
  | { name: "request_visual"; args: { kind: "mermaid" | "katex" | "image" | "widget"; title: string; description: string } }
  | { name: "mark_understood"; args: { topic: string } }
  | { name: "read_widget"; args: { visual_id: string } };

type Caption =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; final: boolean }
  | { kind: "tool"; id: string; name: string; args: unknown; result?: unknown };

type Props = {
  lessonId: string;
  onToolCall: (call: ToolCall) => Promise<unknown> | unknown;
};

type Status = "idle" | "connecting" | "live" | "ended" | "error";

// AudioWorklet that downsamples mic audio (typically 48kHz) to 16kHz Int16 PCM
// for Gemini Live. Posted as ArrayBuffer to the main thread.
const PCM_ENCODER_WORKLET = `
class PcmEncoder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const targetRate = 16000;
    const ratio = sampleRate / targetRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0, count = 0;
      for (let j = start; j < end; j++) { sum += input[j]; count++; }
      const avg = count > 0 ? sum / count : 0;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(avg * 32767)));
    }
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}
registerProcessor("pcm-encoder", PcmEncoder);
`;

function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Chunked to avoid stack overflow on large buffers.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Gemini Live output PCM is 16-bit little-endian.
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

export function RealtimeSession({ lessonId, onToolCall }: Props) {
  const sessionRef = useRef<Session | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micTracksRef = useRef<MediaStreamTrack[]>([]);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const modelAnalyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const modelLastActiveRef = useRef<number>(Date.now());
  const nextPlayStartRef = useRef<number>(0);
  const pendingSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechEndMonitorRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseHadAudioRef = useRef(false);
  const captionScrollRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [showCaptions, setShowCaptions] = useState(true);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [halfDuplex, setHalfDuplex] = useState(true);
  const halfDuplexRef = useRef(true);
  const mutedRef = useRef(false);
  useEffect(() => { halfDuplexRef.current = halfDuplex; }, [halfDuplex]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const SILENCE_DETECT_MS = 500;
  const SILENCE_RMS_THRESHOLD = 0.005;
  const AUTO_ADVANCE_MS = 8000;

  useEffect(() => () => stop(), []);

  useEffect(() => {
    const el = captionScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [captions]);

  function appendCaption(c: Caption) { setCaptions((p) => [...p, c]); }

  function upsertAssistant(id: string, deltaOrFinal: { delta?: string; finalText?: string }) {
    setCaptions((prev) => {
      const idx = prev.findIndex((c) => c.kind === "assistant" && c.id === id);
      if (idx === -1) {
        return [...prev, {
          kind: "assistant",
          id,
          text: deltaOrFinal.finalText ?? deltaOrFinal.delta ?? "",
          final: deltaOrFinal.finalText !== undefined,
        }];
      }
      const next = [...prev];
      const existing = next[idx] as Extract<Caption, { kind: "assistant" }>;
      next[idx] = {
        ...existing,
        text: deltaOrFinal.finalText !== undefined
          ? deltaOrFinal.finalText
          : existing.text + (deltaOrFinal.delta ?? ""),
        final: deltaOrFinal.finalText !== undefined ? true : existing.final,
      };
      return next;
    });
  }

  function updateToolResult(callId: string, result: unknown) {
    setCaptions((prev) => {
      const idx = prev.findIndex((c) => c.kind === "tool" && c.id === callId);
      if (idx === -1) return prev;
      const next = [...prev];
      const existing = next[idx] as Extract<Caption, { kind: "tool" }>;
      next[idx] = { ...existing, result };
      return next;
    });
  }

  function clearAutoAdvance() {
    if (speechEndMonitorRef.current) { clearTimeout(speechEndMonitorRef.current); speechEndMonitorRef.current = null; }
    if (autoAdvanceRef.current) { clearTimeout(autoAdvanceRef.current); autoAdvanceRef.current = null; }
  }

  function fireAutoAdvance() {
    const session = sessionRef.current;
    if (!session) return;
    session.sendClientContent({
      turns: [{
        role: "user",
        parts: [{ text: "(student is listening but hasn't spoken — if there's more to say in the current section, finish that first; otherwise transition naturally to the next section. Do not acknowledge this message.)" }],
      }],
      turnComplete: true,
    });
  }

  function scheduleAutoAdvance() {
    clearAutoAdvance();
    const watchSilence = () => {
      const silentFor = Date.now() - modelLastActiveRef.current;
      if (silentFor >= SILENCE_DETECT_MS) {
        if (halfDuplexRef.current) setMicEnabled(true);
        autoAdvanceRef.current = setTimeout(fireAutoAdvance, AUTO_ADVANCE_MS);
      } else {
        const wait = Math.max(50, SILENCE_DETECT_MS - silentFor + 50);
        speechEndMonitorRef.current = setTimeout(watchSilence, wait);
      }
    };
    speechEndMonitorRef.current = setTimeout(watchSilence, SILENCE_DETECT_MS);
  }

  function setMicEnabled(enabled: boolean) {
    const tracks = micTracksRef.current;
    const effective = enabled && !mutedRef.current;
    tracks.forEach((t) => { t.enabled = effective; });
  }

  function toggleMute() {
    if (micTracksRef.current.length === 0) return;
    const next = !muted;
    micTracksRef.current.forEach((t) => { t.enabled = !next; });
    setMuted(next);
  }

  function clearPlayback() {
    pendingSourcesRef.current.forEach((s) => { try { s.stop(); } catch { /* already stopped */ } });
    pendingSourcesRef.current = [];
    nextPlayStartRef.current = audioCtxRef.current?.currentTime ?? 0;
  }

  function interruptTutor() {
    clearPlayback();
    setMicEnabled(true);
    setSpeaking(false);
  }

  async function start() {
    setStatus("connecting");
    setError(null);
    setCaptions([]);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access is unavailable. Open this page at http://localhost:7100 (not the LAN IP).");
      }

      const sessionRes = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId }),
      });
      const data = await sessionRes.json();
      if (!sessionRes.ok) throw new Error(data.error ?? "session failed");
      const { token, model } = data as { token: string; model: string };

      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;

      // Mic capture + downsampling
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      micStreamRef.current = mic;
      micTracksRef.current = mic.getTracks();

      const blob = new Blob([PCM_ENCODER_WORKLET], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const micSource = ctx.createMediaStreamSource(mic);
      const worklet = new AudioWorkletNode(ctx, "pcm-encoder");
      workletNodeRef.current = worklet;
      const micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 512;
      micAnalyser.smoothingTimeConstant = 0.6;
      micAnalyserRef.current = micAnalyser;
      micSource.connect(micAnalyser);
      micSource.connect(worklet);
      // Worklet must be connected somewhere to keep its process loop alive,
      // but we don't want its audio routed to speakers (would echo).
      const silentSink = ctx.createGain();
      silentSink.gain.value = 0;
      worklet.connect(silentSink).connect(ctx.destination);

      // Output analyser that taps into model audio playback for silence detection.
      const modelAnalyser = ctx.createAnalyser();
      modelAnalyser.fftSize = 512;
      modelAnalyser.smoothingTimeConstant = 0.6;
      modelAnalyserRef.current = modelAnalyser;
      modelAnalyser.connect(ctx.destination);

      startLevelLoop();

      // Connect to Gemini Live with the ephemeral token.
      const ai = new GoogleGenAI({ apiKey: token });
      const session = await ai.live.connect({
        model,
        config: {
          // The token's liveConnectConstraints already lock systemInstruction + tools.
          // responseModalities also locked, but include here to satisfy SDK shape.
          responseModalities: [Modality.AUDIO],
        },
        callbacks: {
          onopen: () => {
            // Kick off the lesson. The system instructions tell the model to start with the hook.
            session.sendClientContent({
              turns: [{ role: "user", parts: [{ text: "(begin the lesson)" }] }],
              turnComplete: true,
            });
          },
          onmessage: (msg) => handleServerMessage(msg),
          onerror: (e) => {
            setError(e.message ?? "live connection error");
            setStatus("error");
          },
          onclose: () => {
            setStatus((s) => (s === "live" || s === "connecting" ? "ended" : s));
          },
        },
      });
      sessionRef.current = session;

      // Pipe mic audio frames to the live session.
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (mutedRef.current) return;
        const session = sessionRef.current;
        if (!session) return;
        session.sendRealtimeInput({
          audio: { data: abToBase64(e.data), mimeType: "audio/pcm;rate=16000" },
        });
      };

      setStatus("live");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
      stop();
    }
  }

  function startLevelLoop() {
    const ctx = audioCtxRef.current;
    const micA = micAnalyserRef.current;
    const modelA = modelAnalyserRef.current;
    if (!ctx || !micA || !modelA) return;
    const micBuf = new Uint8Array(micA.fftSize);
    const modelBuf = new Uint8Array(modelA.fftSize);
    let smoothedMic = 0;
    let smoothedListening = 0;
    const tick = () => {
      micA.getByteTimeDomainData(micBuf);
      let micSumSq = 0;
      for (let i = 0; i < micBuf.length; i++) { const x = (micBuf[i] - 128) / 128; micSumSq += x * x; }
      const micRms = Math.sqrt(micSumSq / micBuf.length);
      smoothedMic = smoothedMic * 0.7 + Math.min(1, micRms * 4) * 0.3;
      setMicLevel(smoothedMic);
      // Listening indicator: sustained mic activity above threshold.
      const listeningTarget = micRms > SILENCE_RMS_THRESHOLD * 1.5 ? 1 : 0;
      smoothedListening = smoothedListening * 0.7 + listeningTarget * 0.3;
      setListening(smoothedListening > 0.5 && !mutedRef.current);

      modelA.getByteTimeDomainData(modelBuf);
      let modelSumSq = 0;
      for (let i = 0; i < modelBuf.length; i++) { const x = (modelBuf[i] - 128) / 128; modelSumSq += x * x; }
      const modelRms = Math.sqrt(modelSumSq / modelBuf.length);
      if (modelRms > SILENCE_RMS_THRESHOLD) modelLastActiveRef.current = Date.now();

      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopLevelLoop() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  function stop() {
    clearAutoAdvance();
    stopLevelLoop();
    clearPlayback();
    sessionRef.current?.close();
    sessionRef.current = null;
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    micTracksRef.current.forEach((t) => t.stop());
    micTracksRef.current = [];
    micStreamRef.current = null;
    audioCtxRef.current?.close().catch(() => { /* already closed */ });
    audioCtxRef.current = null;
    micAnalyserRef.current = null;
    modelAnalyserRef.current = null;
    setListening(false);
    setSpeaking(false);
    setMuted(false);
    setMicLevel(0);
    setStatus((s) => (s === "live" || s === "connecting" ? "ended" : s));
  }

  function playPcmFrame(b64: string, sampleRate: number) {
    const ctx = audioCtxRef.current;
    const analyser = modelAnalyserRef.current;
    if (!ctx || !analyser) return;
    const int16 = base64ToInt16(b64);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const buffer = ctx.createBuffer(1, float32.length, sampleRate);
    buffer.getChannelData(0).set(float32);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    const startAt = Math.max(ctx.currentTime, nextPlayStartRef.current);
    source.start(startAt);
    nextPlayStartRef.current = startAt + buffer.duration;
    pendingSourcesRef.current.push(source);
    source.onended = () => {
      pendingSourcesRef.current = pendingSourcesRef.current.filter((s) => s !== source);
    };
  }

  async function handleServerMessage(msg: LiveServerMessage) {
    if (msg.toolCall?.functionCalls?.length) {
      // Bookkeeping for half-duplex: tool call responses don't produce audio.
      // Do not adjust mic state here — the next response.* events handle it.
      for (const fc of msg.toolCall.functionCalls) {
        const callId = fc.id ?? `${fc.name}-${Date.now()}`;
        const name = fc.name as ToolCall["name"];
        const args = (fc.args ?? {}) as ToolCall["args"];
        appendCaption({ kind: "tool", id: callId, name, args });
        let result: unknown;
        try {
          result = await onToolCall({ name, args } as ToolCall);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        updateToolResult(callId, result);
        sessionRef.current?.sendToolResponse({
          functionResponses: [{
            id: callId,
            name: fc.name ?? "",
            response: (result as Record<string, unknown>) ?? { ok: true },
          }],
        });
      }
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    // Output audio (PCM 24kHz inline data on modelTurn parts).
    const parts = sc.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType ?? "";
        // Mime is "audio/pcm;rate=24000" — extract sample rate when present.
        const rateMatch = mime.match(/rate=(\d+)/);
        const rate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
        if (!speaking) setSpeaking(true);
        responseHadAudioRef.current = true;
        playPcmFrame(part.inlineData.data, rate);
      }
    }

    // Streaming output transcription (assistant captions).
    if (sc.outputTranscription?.text) {
      // Use a stable id per turn — Gemini doesn't expose item ids, so use a single id
      // that resets when turnComplete arrives.
      const turnId = currentAssistantTurnIdRef.current ??= `turn-${Date.now()}`;
      upsertAssistant(turnId, { delta: sc.outputTranscription.text });
    }

    // Streaming input (user mic) transcription.
    if (sc.inputTranscription?.text) {
      const turnId = currentUserTurnIdRef.current ??= `user-${Date.now()}`;
      // Whisper-style we'd want streaming, but Gemini fires partials. Replace
      // the row contents until finished=true.
      setCaptions((prev) => {
        const idx = prev.findIndex((c) => c.kind === "user" && c.id === turnId);
        const text = sc.inputTranscription!.text!;
        if (idx === -1) return [...prev, { kind: "user", id: turnId, text }];
        const next = [...prev];
        next[idx] = { kind: "user", id: turnId, text };
        return next;
      });
      if (sc.inputTranscription.finished) currentUserTurnIdRef.current = null;
    }

    if (sc.interrupted) {
      // Server detected user speech and cancelled the model's response.
      clearPlayback();
      setSpeaking(false);
      if (halfDuplexRef.current) setMicEnabled(true);
      clearAutoAdvance();
      currentAssistantTurnIdRef.current = null;
    }

    if (sc.turnComplete) {
      // Finalize the current assistant caption.
      const turnId = currentAssistantTurnIdRef.current;
      if (turnId) {
        setCaptions((prev) => prev.map((c) =>
          c.kind === "assistant" && c.id === turnId ? { ...c, final: true } : c,
        ));
      }
      currentAssistantTurnIdRef.current = null;
      setSpeaking(false);
      if (responseHadAudioRef.current) {
        scheduleAutoAdvance();
      } else if (halfDuplexRef.current) {
        setMicEnabled(true);
      }
      responseHadAudioRef.current = false;
    }
  }

  // Refs declared at component scope but used inside the message handler.
  const currentAssistantTurnIdRef = useRef<string | null>(null);
  const currentUserTurnIdRef = useRef<string | null>(null);

  return (
    <div className="panel" style={{ position: "sticky", bottom: 12 }}>
      {showCaptions && (
        <div
          ref={captionScrollRef}
          style={{
            maxHeight: 220, overflowY: "auto",
            background: "var(--bg)", border: "1px solid var(--border)",
            borderRadius: 8, padding: 12, marginBottom: 12,
            fontSize: 14, lineHeight: 1.5,
          }}
        >
          {captions.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Captions will appear here once the lesson starts.</div>}
          {captions.map((c, i) => <CaptionRow key={`${c.kind}-${c.id}-${i}`} c={c} />)}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {status === "idle" || status === "ended" || status === "error" ? (
          <button className="primary" onClick={start}>Start lesson</button>
        ) : (
          <>
            <button className="ghost" onClick={stop}>End</button>
            <button className="ghost" onClick={toggleMute}>{muted ? "Unmute mic" : "Mute mic"}</button>
            {speaking && halfDuplex && (
              <button className="primary" onClick={interruptTutor}>Interrupt</button>
            )}
            <Indicator
              label={muted ? "muted" : listening ? "listening" : speaking ? "tutor speaking" : "ready"}
              color={muted ? "var(--muted)" : listening ? "#4ade80" : speaking ? "var(--accent)" : "var(--muted)"}
              pulsing={listening || speaking}
            />
            <LevelMeter level={muted ? 0 : micLevel} active={listening} />
            <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }} className="muted">
              <input type="checkbox" checked={!halfDuplex} onChange={(e) => setHalfDuplex(!e.target.checked)} />
              headphones (allow voice interrupt)
            </label>
            <span className="muted" style={{ fontSize: 12 }}>
              {halfDuplex ? "Tap Interrupt to break in." : "Just speak to interrupt."}
            </span>
          </>
        )}
        <button className="ghost" onClick={() => setShowCaptions((s) => !s)} style={{ marginLeft: "auto" }}>
          {showCaptions ? "Hide captions" : "Show captions"}
        </button>
        {error && <span style={{ color: "salmon", fontSize: 13 }}>{error}</span>}
        {status === "connecting" && <span className="muted" style={{ fontSize: 12 }}>connecting…</span>}
      </div>
    </div>
  );
}

function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const bars = 12;
  const lit = Math.round(level * bars);
  return (
    <span style={{ display: "inline-flex", gap: 2, alignItems: "flex-end", height: 14 }}>
      {Array.from({ length: bars }).map((_, i) => {
        const on = i < lit;
        const h = 4 + (i / (bars - 1)) * 10;
        return (
          <span key={i} style={{
            width: 3, height: h, borderRadius: 1,
            background: on ? (active ? "#4ade80" : "var(--accent)") : "var(--border)",
            transition: "background 60ms linear",
          }} />
        );
      })}
    </span>
  );
}

function Indicator({ label, color, pulsing }: { label: string; color: string; pulsing: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
      <span style={{
        width: 10, height: 10, borderRadius: "50%", background: color,
        boxShadow: pulsing ? `0 0 0 0 ${color}` : "none",
        animation: pulsing ? "ptPulse 1.2s ease-out infinite" : "none",
      }} />
      <span className="muted">{label}</span>
      <style>{`@keyframes ptPulse { 0% { box-shadow: 0 0 0 0 ${color}66; } 70% { box-shadow: 0 0 0 8px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }`}</style>
    </span>
  );
}

function CaptionRow({ c }: { c: Caption }) {
  if (c.kind === "user") {
    return (
      <div style={{ marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 12, marginRight: 6 }}>you</span>
        {c.text}
      </div>
    );
  }
  if (c.kind === "assistant") {
    return (
      <div style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 12, marginRight: 6, color: "var(--accent)" }}>tutor</span>
        {c.text || <span className="muted" style={{ fontSize: 12 }}>…</span>}
        {!c.final && <span className="muted" style={{ marginLeft: 4 }}>▍</span>}
      </div>
    );
  }
  return (
    <div className="muted" style={{ marginBottom: 6, fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
      → {c.name}({truncate(JSON.stringify(c.args))})
      {c.result !== undefined && <span> ⇒ {truncate(JSON.stringify(c.result))}</span>}
    </div>
  );
}

function truncate(s: string, max = 90): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
