import { randomUUID } from "node:crypto";
import { Type } from "@google/genai";
import { gemini, PLANNER_MODEL } from "@/lib/gemini";
import type { LessonOutline, Paper, VisualSpec } from "@/types";

const SYSTEM = `You are a curriculum designer. Given a research paper, produce a short, engaging lesson outline a tutor can teach in 10–15 minutes of voice + visuals.

Rules:
- 4–6 sections, progressing from intuition → mechanism → application → limitations.
- Prefer "mermaid" for architectures/pipelines/flows, "katex" for key equations, "widget" for ideas that benefit from interactive manipulation (sliders, draggable vectors, live computation), "image" when none of the above fit.
- Use "widget" sparingly — at most one or two per lesson, and only when interactivity adds real understanding.
- Every section should reference at least one visual.
- Be concrete. Avoid filler like "this is important".`;

const SCHEMA = {
  type: Type.OBJECT,
  required: ["title", "hook", "prerequisites", "sections", "visuals"],
  properties: {
    title: { type: Type.STRING },
    hook: { type: Type.STRING },
    prerequisites: { type: Type.ARRAY, items: { type: Type.STRING } },
    sections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["id", "title", "summary", "keyPoints", "visualIds"],
        properties: {
          id: { type: Type.STRING },
          title: { type: Type.STRING },
          summary: { type: Type.STRING },
          keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
          visualIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
      },
    },
    visuals: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["id", "kind", "title", "description"],
        properties: {
          id: { type: Type.STRING },
          kind: { type: Type.STRING, enum: ["mermaid", "katex", "image", "widget"] },
          title: { type: Type.STRING },
          description: { type: Type.STRING },
        },
      },
    },
  },
};

export type PlannerResult = {
  outline: LessonOutline;
  visuals: VisualSpec[];
};

export async function planLesson(paper: Paper, paperText: string): Promise<PlannerResult> {
  const truncated = paperText.slice(0, 60_000);
  const user = `Title: ${paper.title}
Authors: ${paper.authors.join(", ")}
Abstract: ${paper.abstract}

Paper text (truncated):
${truncated}`;

  const res = await gemini().models.generateContent({
    model: PLANNER_MODEL,
    contents: [{ role: "user", parts: [{ text: user }] }],
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
    },
  });

  const raw = res.text;
  if (!raw) throw new Error("planner: empty response");
  const parsed = JSON.parse(raw) as {
    title: string;
    hook: string;
    prerequisites: string[];
    sections: LessonOutline["sections"];
    visuals: VisualSpec[];
  };

  const visuals: VisualSpec[] = (parsed.visuals ?? []).map((v) => ({
    id: v.id || `v-${randomUUID().slice(0, 8)}`,
    kind: v.kind,
    title: v.title,
    description: v.description,
  }));

  const outline: LessonOutline = {
    title: parsed.title,
    hook: parsed.hook,
    prerequisites: parsed.prerequisites ?? [],
    sections: parsed.sections ?? [],
  };

  return { outline, visuals };
}
