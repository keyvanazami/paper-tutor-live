import { NextResponse } from "next/server";
import { createLesson, updateLesson } from "@/lib/store";
import { generateAdHocVisual } from "@/lib/pipeline";
import { DEMO_OUTLINE, DEMO_PAPER, buildDemoVisuals, pendingDemoImageSpecs } from "@/lib/demo";

export const runtime = "nodejs";

export async function POST() {
  const lesson = await createLesson(DEMO_PAPER);
  await updateLesson(lesson.id, {
    status: "rendering",
    outline: DEMO_OUTLINE,
    visuals: buildDemoVisuals(),
  });

  // Kick off image/widget generation for any visual without a pre-baked payload.
  for (const spec of pendingDemoImageSpecs()) {
    generateAdHocVisual(lesson.id, spec);
  }
  // Mark ready immediately — pre-baked visuals already work; live ones stream in.
  await updateLesson(lesson.id, { status: "ready" });

  return NextResponse.json({ id: lesson.id });
}
