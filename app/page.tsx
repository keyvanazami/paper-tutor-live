"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Paper } from "@/types";

export default function Home() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [papers, setPapers] = useState<Paper[]>([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setSearching(true);
    setError(null);
    setPapers([]);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "search failed");
      setPapers(data.papers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  async function pick(paper: Paper) {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "create failed");
      router.push(`/lesson/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }

  return (
    <main className="container">
      <h1>Paper Tutor</h1>
      <p className="muted">Pick a topic. We&apos;ll find the most relevant paper and turn it into a 10-minute interactive lesson.</p>

      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        <input
          placeholder="e.g. mixture of experts for language models"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
        />
        <button className="primary" onClick={search} disabled={!topic || searching}>
          {searching ? "Searching…" : "Search"}
        </button>
      </div>

      <div style={{ marginTop: 12 }}>
        <button
          className="ghost"
          onClick={async () => {
            setCreating(true);
            setError(null);
            try {
              const res = await fetch("/api/lessons/demo", { method: "POST" });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error ?? "demo failed");
              router.push(`/lesson/${data.id}`);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setCreating(false);
            }
          }}
          disabled={creating}
        >
          {creating ? "Loading…" : "Try the demo lesson (Transformers)"}
        </button>
      </div>

      {error && <p style={{ color: "salmon", marginTop: 16 }}>{error}</p>}

      <div style={{ display: "grid", gap: 12, marginTop: 24 }}>
        {papers.map((p) => (
          <div key={p.id} className="panel">
            <div style={{ fontWeight: 600 }}>{p.title}</div>
            <div className="muted" style={{ fontSize: 13, margin: "4px 0" }}>
              {p.authors.slice(0, 4).join(", ")}{p.authors.length > 4 ? " et al." : ""}
            </div>
            <div style={{ fontSize: 14 }}>{p.abstract.slice(0, 280)}{p.abstract.length > 280 ? "…" : ""}</div>
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button className="primary" onClick={() => pick(p)} disabled={creating}>
                {creating ? "Building lesson…" : "Teach me this"}
              </button>
              <a href={p.url} target="_blank" rel="noreferrer">
                <button className="ghost">View on arXiv</button>
              </a>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
