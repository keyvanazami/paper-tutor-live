import { NextResponse } from "next/server";
import { searchArxiv } from "@/lib/arxiv";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { topic } = (await req.json()) as { topic?: string };
  if (!topic || typeof topic !== "string") {
    return NextResponse.json({ error: "topic required" }, { status: 400 });
  }
  try {
    const papers = await searchArxiv(topic, 5);
    return NextResponse.json({ papers });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
