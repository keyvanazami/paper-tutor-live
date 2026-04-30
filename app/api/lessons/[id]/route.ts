import { NextResponse } from "next/server";
import { getLesson } from "@/lib/store";
import { generateAdHocVisual } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lesson = await getLesson(id);
  if (!lesson) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(lesson);
}

// Browser tool dispatcher posts here when the realtime model calls request_visual.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as {
    action: "request_visual";
    visualId: string;
    kind: "mermaid" | "katex" | "image" | "widget";
    title: string;
    description: string;
  };
  if (body.action !== "request_visual") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  // Kick off generation in the background. The model gets a fast tool reply
  // ("pending") and is instructed to narrate while the visual loads — much
  // more conversational than holding the model silent for 5–15s on images.
  generateAdHocVisual(id, {
    id: body.visualId,
    kind: body.kind,
    title: body.title,
    description: body.description,
  });
  return NextResponse.json({ visualId: body.visualId, status: "pending" });
}
