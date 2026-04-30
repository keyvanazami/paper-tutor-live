import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gemini, IMAGE_MODEL, PLANNER_MODEL } from "@/lib/gemini";
import type { VisualSpec } from "@/types";

const MERMAID_SYSTEM = `You render concepts as Mermaid diagrams. Output ONLY valid Mermaid source — no fences, no prose, no explanation. Prefer "flowchart LR" for pipelines and "graph TD" for hierarchies. Keep node labels short (≤ 6 words). Max 12 nodes.`;

const KATEX_SYSTEM = `Output ONLY a single LaTeX equation (no \\begin{...}, no $$ delimiters, no prose). Suitable for KaTeX rendering. Choose the most load-bearing equation from the description.`;

const WIDGET_SYSTEM = `You generate a single-file, self-contained HTML widget that teaches a concept INTERACTIVELY. The student should be able to drag, click, slide, hover, or otherwise manipulate something and see a result update live.

OUTPUT RULES:
- Output ONLY the HTML document (starting with <!doctype html>). No fences, no prose, no markdown.
- Everything inline in one document: <style> in <head>, <script> at end of <body>. No external resources.
- Vanilla JS only. No frameworks, no CDN imports, no fetch/XHR, no localStorage, no analytics.
- Body fills 100% width, max-height 460px, no scroll. Touch-friendly hit targets (≥ 32px).

VISUAL STYLE (must match parent app):
- background: #0b0b0d, text: #e6e6e6, accent: #7c5cff, border: #2a2a32, muted: #9aa0a6
- font: system-ui, -apple-system, "Segoe UI", sans-serif
- generous spacing, rounded corners (8px), no emojis

CONTENT:
- ONE concept, demonstrated cleanly. Less is more.
- Include a single short caption (≤ 1 sentence) explaining what to do.
- Math should use clean unicode where possible, not LaTeX.

INTERACTIVITY PROTOCOL (REQUIRED):
The widget runs inside a sandboxed iframe. The host will postMessage \`{ kind: "init", visualId }\` to the widget on load. The widget must:
1. Receive the init message and remember the visualId.
2. After every meaningful state change (e.g., slider released, value committed, click), call:
   parent.postMessage({ kind: "widget-state", visualId, state: { ... } }, "*")
   where \`state\` is a small JSON object describing the user's current configuration in plain terms (e.g. { logits: [1.2, 0.5, ...], probs: [0.4, 0.3, ...] }).
3. Debounce updates so you send at most one message every ~250ms during continuous interaction.
4. Do NOT send state on every animation frame — only on user-driven changes.

Skeleton:
  <script>
  let visualId = null;
  let lastSent = 0;
  window.addEventListener("message", (e) => {
    if (e.data?.kind === "init" && typeof e.data.visualId === "string") visualId = e.data.visualId;
  });
  function notify(state) {
    if (!visualId) return;
    const now = Date.now();
    if (now - lastSent < 250) return;
    lastSent = now;
    parent.postMessage({ kind: "widget-state", visualId, state }, "*");
  }
  </script>
Use notify(...) from your event handlers.`;

export async function renderVisual(spec: VisualSpec, lessonId: string): Promise<string> {
  if (spec.kind === "mermaid") return generate(MERMAID_SYSTEM, spec);
  if (spec.kind === "katex") return generate(KATEX_SYSTEM, spec);
  if (spec.kind === "widget") return generate(WIDGET_SYSTEM, spec);
  return renderImage(spec, lessonId);
}

async function generate(system: string, spec: VisualSpec): Promise<string> {
  const res = await gemini().models.generateContent({
    model: PLANNER_MODEL,
    contents: [{ role: "user", parts: [{ text: `${spec.title}\n\n${spec.description}` }] }],
    config: { systemInstruction: system },
  });
  const out = res.text?.trim();
  if (!out) throw new Error(`visual ${spec.id}: empty`);
  return stripFences(out);
}

function stripFences(s: string): string {
  return s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
}

async function renderImage(spec: VisualSpec, lessonId: string): Promise<string> {
  // Style direction matches the app palette (dark, accent purple, muted gray).
  // CRITICAL: forbid text overlays — generated text in images looks oversized
  // and inconsistent next to the lesson copy. If labels are needed, the
  // planner should choose mermaid instead.
  const prompt = `Editorial diagram-style illustration on a near-black background (#0b0b0d). Clean flat shapes with thin lines, soft purple accents (#7c5cff), muted grays. Conceptual visual metaphor only — NO text, NO labels, NO captions, NO annotations of any kind. Composition fills a 16:10 frame with generous negative space; subjects centered or rule-of-thirds. Avoid photorealism, avoid 3D rendering, avoid clipart. Single coherent scene, not a grid of panels.

Concept: ${spec.title}.
Visual idea: ${spec.description}`;

  const res = await gemini().models.generateContent({
    model: IMAGE_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  // Nano Banana returns image data inline in candidate parts.
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    throw new Error("image: no inlineData in response");
  }

  const dir = path.join(process.cwd(), "public", "visuals", lessonId);
  await mkdir(dir, { recursive: true });
  const ext = (imagePart.inlineData.mimeType ?? "image/png").includes("jpeg") ? "jpg" : "png";
  const file = path.join(dir, `${spec.id}.${ext}`);
  await writeFile(file, Buffer.from(imagePart.inlineData.data, "base64"));

  return `/visuals/${lessonId}/${spec.id}.${ext}`;
}
