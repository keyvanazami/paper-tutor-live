import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchPaperContents, type PaperImage } from "@/lib/arxiv";
import { planLesson } from "@/lib/planner";
import { renderVisual } from "@/lib/visuals";
import { getLesson, setVisual, updateLesson } from "@/lib/store";
import type { Section, Visual } from "@/types";

// Filter heuristics tuned against real arxiv papers:
//   - Area gate (not separate w/h) lets through wide-strip diagrams like the
//     ViT patch sequence (1411×150 = ~210k px) which a strict 300×200 minimum
//     would reject.
//   - Min dimension stops icon-shaped strips from sneaking through.
//   - Density filter (bytes/pixel) drops near-solid background tiles which
//     compress to <0.02 bpp at 600×600.
const MIN_FIGURE_AREA = 40_000;
const MIN_FIGURE_DIM = 150;
const MIN_BYTES_PER_PIXEL = 0.03;
const MAX_FIGURES = 6;

async function savePaperFigures(
  lessonId: string,
  images: PaperImage[],
): Promise<Record<string, Visual>> {
  const seen = new Set<string>();
  const eligible: PaperImage[] = [];
  for (const img of images) {
    const area = img.width * img.height;
    if (area < MIN_FIGURE_AREA) continue;
    if (img.width < MIN_FIGURE_DIM || img.height < MIN_FIGURE_DIM / 2) continue;
    const density = img.data.length / area;
    if (density < MIN_BYTES_PER_PIXEL) continue;
    const hash = createHash("sha1").update(img.data).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    eligible.push(img);
  }
  eligible.sort((a, b) => b.width * b.height - a.width * a.height);
  const top = eligible.slice(0, MAX_FIGURES);

  if (top.length === 0) return {};

  const dir = path.join(process.cwd(), "public", "visuals", lessonId);
  await mkdir(dir, { recursive: true });

  const out: Record<string, Visual> = {};
  for (let i = 0; i < top.length; i++) {
    const img = top[i];
    const id = `paper-${i + 1}`;
    const filename = `${id}.${img.ext}`;
    await writeFile(path.join(dir, filename), img.data);
    out[id] = {
      id,
      kind: "image",
      title: `Figure from page ${img.page}`,
      description: `Original figure extracted from page ${img.page} of the paper (${img.width}×${img.height}).`,
      status: "ready",
      payload: `/visuals/${lessonId}/${filename}`,
    };
  }
  return out;
}

export async function runLessonPipeline(lessonId: string): Promise<void> {
  const start = await getLesson(lessonId);
  if (!start) return;

  try {
    await updateLesson(lessonId, { status: "researching" });
    let paperText: string;
    let paperImages: PaperImage[];
    try {
      const contents = await fetchPaperContents(start.paper.pdfUrl);
      paperText = contents.text;
      paperImages = contents.images;
    } catch (err) {
      throw new Error(`pdf-fetch: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Save paper figures alongside text. Failures here aren't fatal.
    let paperFigureVisuals: Record<string, Visual> = {};
    try {
      paperFigureVisuals = await savePaperFigures(lessonId, paperImages);
    } catch (err) {
      console.warn(`[pipeline ${lessonId}] paper-figures failed:`, err);
    }

    await updateLesson(lessonId, { status: "planning" });
    let outline, visuals;
    try {
      const planned = await planLesson(start.paper, paperText);
      outline = planned.outline;
      visuals = planned.visuals;
    } catch (err) {
      throw new Error(`planner: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Append a "Figures from the paper" section with the extracted bitmaps
    // so the model can highlight them via highlight_visual during the lesson.
    const paperFigureIds = Object.keys(paperFigureVisuals);
    if (paperFigureIds.length > 0) {
      const figuresSection: Section = {
        id: "paper-figures",
        title: "Figures from the paper",
        summary: "The original figures from the paper, for reference and discussion.",
        keyPoints: [],
        visualIds: paperFigureIds,
      };
      outline = { ...outline, sections: [...outline.sections, figuresSection] };
    }

    const visualMap: Record<string, Visual> = {
      ...paperFigureVisuals,
      ...Object.fromEntries(visuals.map((v) => [v.id, { ...v, status: "pending" as const }])),
    };
    await updateLesson(lessonId, { outline, visuals: visualMap, status: "rendering" });

    // Render visuals in parallel; failures don't block the lesson.
    await Promise.all(
      visuals.map(async (spec) => {
        try {
          const payload = await renderVisual(spec, lessonId);
          await setVisual(lessonId, spec.id, { ...spec, status: "ready", payload });
        } catch (err) {
          await setVisual(lessonId, spec.id, {
            ...spec,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    await updateLesson(lessonId, { status: "ready" });
  } catch (err) {
    console.error(`[pipeline ${lessonId}] failed:`, err);
    await updateLesson(lessonId, {
      status: "error",
      error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err),
    });
  }
}

// Adaptive: realtime model can request a brand-new visual mid-lesson.
// Marks pending immediately, then runs generation in the background so the
// realtime tool call can return fast and the model can keep narrating.
export function generateAdHocVisual(
  lessonId: string,
  spec: { id: string; kind: "mermaid" | "katex" | "image" | "widget"; title: string; description: string },
): void {
  setVisual(lessonId, spec.id, { ...spec, status: "pending" });
  void (async () => {
    try {
      const payload = await renderVisual(spec, lessonId);
      setVisual(lessonId, spec.id, { ...spec, status: "ready", payload });
    } catch (err) {
      setVisual(lessonId, spec.id, {
        ...spec,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
