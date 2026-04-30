"use client";
import { useEffect, useRef, useState } from "react";

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return m;
    });
  }
  return mermaidPromise;
}

export function MermaidDiagram({ id, source }: { id: string; source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadMermaid().then(async (m) => {
      try {
        const { svg } = await m.default.render(`mermaid-${id}`, source);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => { cancelled = true; };
  }, [id, source]);

  if (error) return <pre style={{ color: "salmon", whiteSpace: "pre-wrap" }}>{error}</pre>;
  return <div ref={ref} />;
}
