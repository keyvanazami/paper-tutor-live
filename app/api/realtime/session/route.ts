import { NextResponse } from "next/server";
import { Modality } from "@google/genai";
import { gemini, LIVE_MODEL } from "@/lib/gemini";
import { getLesson } from "@/lib/store";
import { buildSystemInstructions, liveTools } from "@/lib/realtime-tools";

export const runtime = "nodejs";

// Mints an ephemeral Gemini auth token keyed to a specific lesson.
// Browser uses the token (token.name) to open the Live WebSocket directly,
// keeping the long-lived API key server-side only.
export async function POST(req: Request) {
  const { lessonId } = (await req.json()) as { lessonId?: string };
  if (!lessonId) return NextResponse.json({ error: "lessonId required" }, { status: 400 });

  const lesson = await getLesson(lessonId);
  if (!lesson) return NextResponse.json({ error: "lesson not found" }, { status: 404 });
  if (!lesson.outline) {
    return NextResponse.json({ error: "lesson not ready" }, { status: 409 });
  }

  const outlineSummary = lesson.outline.sections
    .map((s) => `- [${s.id}] ${s.title}: ${s.summary}`)
    .join("\n");

  const instructions = buildSystemInstructions({
    lessonTitle: lesson.outline.title,
    hook: lesson.outline.hook,
    outlineSummary,
  });

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY missing" }, { status: 500 });
  }

  try {
    const token = await gemini().authTokens.create({
      config: {
        // Token is one-shot (default uses=1) and expires in 30 min.
        // Live session itself can run up to its own session limit.
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: instructions,
            tools: [{ functionDeclarations: liveTools }],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        },
        // Locks the constraint fields so the browser can't override them.
        lockAdditionalFields: [],
      },
    });
    return NextResponse.json({ token: token.name, model: LIVE_MODEL });
  } catch (err) {
    return NextResponse.json(
      { error: `live session: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }
}
