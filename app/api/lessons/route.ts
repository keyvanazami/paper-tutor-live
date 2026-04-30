import { NextResponse } from "next/server";
import { createLesson } from "@/lib/store";
import { runLessonPipeline } from "@/lib/pipeline";
import type { Paper } from "@/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { paper } = (await req.json()) as { paper?: Paper };
  if (!paper || !paper.pdfUrl) {
    return NextResponse.json({ error: "paper required" }, { status: 400 });
  }
  const lesson = await createLesson(paper);
  // Fire and forget — UI polls GET /api/lessons/[id].
  void runLessonPipeline(lesson.id);
  return NextResponse.json({ id: lesson.id });
}
