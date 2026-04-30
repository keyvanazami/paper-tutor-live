"use client";
import type { Visual } from "@/types";
import { MermaidDiagram } from "./MermaidDiagram";
import { KatexBlock } from "./KatexBlock";

export function VisualBlock({ visual }: { visual: Visual }) {
  if (visual.status === "pending") {
    return <div className="muted" style={{ fontSize: 13 }}>Generating: {visual.title}…</div>;
  }
  if (visual.status === "error") {
    return <div style={{ color: "salmon", fontSize: 13 }}>Visual failed: {visual.error}</div>;
  }
  if (visual.kind === "mermaid") return <MermaidDiagram id={visual.id} source={visual.payload} />;
  if (visual.kind === "katex") return <KatexBlock source={visual.payload} />;
  if (visual.kind === "widget") {
    // LLM-generated HTML rendered in a sandboxed iframe.
    // sandbox="allow-scripts" only — NOT allow-same-origin — so the widget
    // cannot read parent cookies, localStorage, or DOM.
    // On load we postMessage the visualId in so the widget can tag its
    // outbound state messages, which the lesson page listens for.
    const onLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
      e.currentTarget.contentWindow?.postMessage(
        { kind: "init", visualId: visual.id },
        "*",
      );
    };
    return (
      <iframe
        title={visual.title}
        sandbox="allow-scripts"
        srcDoc={visual.payload}
        onLoad={onLoad}
        style={{
          width: "100%",
          height: 480,
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "#0b0b0d",
          display: "block",
        }}
      />
    );
  }
  // image: payload is a public path like /visuals/{lessonId}/{visualId}.png
  return (
    <img
      src={visual.payload}
      alt={visual.title}
      style={{
        maxWidth: "100%",
        maxHeight: 380,
        objectFit: "contain",
        borderRadius: 8,
        display: "block",
        margin: "0 auto",
      }}
    />
  );
}
