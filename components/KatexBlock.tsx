"use client";
import { useEffect, useState } from "react";
import "katex/dist/katex.min.css";

export function KatexBlock({ source }: { source: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    import("katex").then((m) => {
      try {
        setHtml(m.default.renderToString(source, { displayMode: true, throwOnError: false }));
      } catch {
        setHtml(`<pre>${source}</pre>`);
      }
    });
  }, [source]);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
