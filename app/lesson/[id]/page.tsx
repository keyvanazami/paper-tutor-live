"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { Lesson } from "@/types";
import { VisualBlock } from "@/components/VisualBlock";
import { RealtimeSession, type ToolCall } from "@/components/RealtimeSession";

export default function LessonPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [highlightedVisual, setHighlightedVisual] = useState<string | null>(null);
  const [understood, setUnderstood] = useState<string[]>([]);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const visualRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Latest state per widget, populated by postMessage from sandboxed iframes.
  // Read by the realtime model via the read_widget tool.
  const widgetStateRef = useRef<Record<string, unknown>>({});

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const data = e.data as { kind?: string; visualId?: string; state?: unknown } | null;
      if (!data || data.kind !== "widget-state") return;
      if (typeof data.visualId !== "string") return;
      widgetStateRef.current[data.visualId] = data.state;
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Poll the lesson record. Stop polling once status is "ready" or "error",
  // BUT keep polling occasionally afterward to pick up ad-hoc visuals from request_visual.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`/api/lessons/${id}`);
        if (res.ok) {
          const data = (await res.json()) as Lesson;
          if (!stopped) setLesson(data);
        }
      } catch { /* keep polling */ }
      const interval = lesson?.status === "ready" ? 3000 : 800;
      if (!stopped) timer = setTimeout(tick, interval);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, lesson?.status]);

  const onToolCall = useCallback<(c: ToolCall) => Promise<unknown>>(async (call) => {
    if (call.name === "goto_section") {
      setActiveSection(call.args.section_id);
      sectionRefs.current[call.args.section_id]?.scrollIntoView({ behavior: "smooth", block: "start" });
      return { ok: true };
    }
    if (call.name === "highlight_visual") {
      setHighlightedVisual(call.args.visual_id);
      visualRefs.current[call.args.visual_id]?.scrollIntoView({ behavior: "smooth", block: "center" });
      return { ok: true };
    }
    if (call.name === "request_visual") {
      const visualId = `adhoc-${Date.now()}`;
      const res = await fetch(`/api/lessons/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request_visual", visualId, ...call.args }),
      });
      const data = await res.json();
      setHighlightedVisual(visualId);
      return { visualId, status: data.visual?.status };
    }
    if (call.name === "mark_understood") {
      setUnderstood((u) => Array.from(new Set([...u, call.args.topic])));
      return { ok: true };
    }
    if (call.name === "read_widget") {
      const state = widgetStateRef.current[call.args.visual_id];
      return { state: state ?? null };
    }
    return { error: "unknown tool" };
  }, [id]);

  const adhocVisuals = useMemo(() => {
    if (!lesson) return [];
    const referenced = new Set(lesson.outline?.sections.flatMap((s) => s.visualIds) ?? []);
    return Object.values(lesson.visuals).filter((v) => !referenced.has(v.id));
  }, [lesson]);

  if (!lesson) return <main className="container"><p>Loading…</p></main>;
  if (lesson.status === "error") {
    return <main className="container"><p style={{ color: "salmon" }}>Error: {lesson.error}</p></main>;
  }

  const outline = lesson.outline;

  return (
    <main className="container" style={{ paddingBottom: 96 }}>
      <a href="/" className="muted" style={{ fontSize: 13 }}>← New lesson</a>
      <h1 style={{ marginTop: 8 }}>{outline?.title ?? lesson.paper.title}</h1>
      <p className="muted">{lesson.paper.authors.slice(0, 4).join(", ")} · <a href={lesson.paper.url} target="_blank" rel="noreferrer">arXiv</a></p>

      {!outline && <p className="muted">Status: {lesson.status}…</p>}

      {outline && (
        <>
          <div className="panel" style={{ marginTop: 16 }}>
            <strong>Hook.</strong> {outline.hook}
            {outline.prerequisites.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 13 }} className="muted">
                Assumes: {outline.prerequisites.join(" · ")}
              </div>
            )}
          </div>

          <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
            {outline.sections.map((s) => (
              <div
                key={s.id}
                ref={(el) => { sectionRefs.current[s.id] = el; }}
                className={`panel section ${activeSection === s.id ? "active" : ""}`}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <h3 style={{ margin: 0 }}>{s.title}</h3>
                  {understood.includes(s.id) && <span className="muted" style={{ fontSize: 12 }}>✓ understood</span>}
                </div>
                <p>{s.summary}</p>
                <ul>{s.keyPoints.map((p, i) => <li key={i}>{p}</li>)}</ul>
                {s.visualIds.map((vid) => {
                  const v = lesson.visuals[vid];
                  if (!v) return null;
                  return (
                    <div
                      key={vid}
                      ref={(el) => { visualRefs.current[vid] = el; }}
                      style={{
                        marginTop: 12, padding: 12, borderRadius: 8,
                        outline: highlightedVisual === vid ? "2px solid var(--accent)" : "1px solid var(--border)",
                      }}
                    >
                      <div style={{ fontSize: 13, marginBottom: 6 }} className="muted">{v.title}</div>
                      <VisualBlock visual={v} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {adhocVisuals.length > 0 && (
            <div className="panel" style={{ marginTop: 16 }}>
              <strong>Generated during conversation</strong>
              <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
                {adhocVisuals.map((v) => (
                  <div
                    key={v.id}
                    ref={(el) => { visualRefs.current[v.id] = el; }}
                    style={{
                      padding: 12, borderRadius: 8,
                      outline: highlightedVisual === v.id ? "2px solid var(--accent)" : "1px solid var(--border)",
                    }}
                  >
                    <div style={{ fontSize: 13, marginBottom: 6 }} className="muted">{v.title}</div>
                    <VisualBlock visual={v} />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: 24 }}>
            <RealtimeSession lessonId={id} onToolCall={onToolCall} />
          </div>
        </>
      )}
    </main>
  );
}
