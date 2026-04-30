import { randomUUID } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import type { Lesson, LessonOutline, Paper, Visual } from "@/types";

declare global {
  // eslint-disable-next-line no-var
  var __paperTutorDb: Client | undefined;
  // eslint-disable-next-line no-var
  var __paperTutorDbInit: Promise<void> | undefined;
}

const url = process.env.DATABASE_URL ?? "file:./paper-tutor.db";
const authToken = process.env.DATABASE_AUTH_TOKEN;

const client: Client = globalThis.__paperTutorDb ?? createClient({ url, authToken });
globalThis.__paperTutorDb = client;

function ensureSchema(): Promise<void> {
  if (!globalThis.__paperTutorDbInit) {
    globalThis.__paperTutorDbInit = (async () => {
      await client.execute(`CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        paper TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        outline TEXT,
        created_at INTEGER NOT NULL
      )`);
      await client.execute(`CREATE TABLE IF NOT EXISTS visuals (
        lesson_id TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (lesson_id, id)
      )`);
    })();
  }
  return globalThis.__paperTutorDbInit;
}

export async function createLesson(paper: Paper): Promise<Lesson> {
  await ensureSchema();
  const lesson: Lesson = {
    id: randomUUID(),
    paper,
    status: "queued",
    visuals: {},
    createdAt: Date.now(),
  };
  await client.execute({
    sql: `INSERT INTO lessons (id, paper, status, created_at) VALUES (?, ?, ?, ?)`,
    args: [lesson.id, JSON.stringify(paper), lesson.status, lesson.createdAt],
  });
  return lesson;
}

export async function getLesson(id: string): Promise<Lesson | undefined> {
  await ensureSchema();
  const lessonRes = await client.execute({
    sql: `SELECT id, paper, status, error, outline, created_at FROM lessons WHERE id = ?`,
    args: [id],
  });
  if (lessonRes.rows.length === 0) return undefined;
  const row = lessonRes.rows[0] as Record<string, unknown>;

  const visualsRes = await client.execute({
    sql: `SELECT id, json FROM visuals WHERE lesson_id = ?`,
    args: [id],
  });
  const visuals: Record<string, Visual> = {};
  for (const v of visualsRes.rows) {
    const r = v as unknown as { id: string; json: string };
    visuals[r.id] = JSON.parse(r.json) as Visual;
  }

  return {
    id: row.id as string,
    paper: JSON.parse(row.paper as string) as Paper,
    status: row.status as Lesson["status"],
    error: (row.error as string | null) ?? undefined,
    outline: row.outline ? (JSON.parse(row.outline as string) as LessonOutline) : undefined,
    visuals,
    createdAt: Number(row.created_at),
  };
}

export async function updateLesson(id: string, patch: Partial<Lesson>): Promise<Lesson | undefined> {
  await ensureSchema();
  const current = await getLesson(id);
  if (!current) return undefined;
  const next = { ...current, ...patch };

  await client.execute({
    sql: `UPDATE lessons SET status = ?, error = ?, outline = ? WHERE id = ?`,
    args: [
      next.status,
      next.error ?? null,
      next.outline ? JSON.stringify(next.outline) : null,
      id,
    ],
  });

  // If the patch included a visuals map, write each visual as its own row.
  // Per-visual writes via setVisual avoid races between this bulk write and
  // background renderers.
  if (patch.visuals) {
    for (const [visualId, visual] of Object.entries(patch.visuals)) {
      await client.execute({
        sql: `INSERT OR REPLACE INTO visuals (lesson_id, id, json) VALUES (?, ?, ?)`,
        args: [id, visualId, JSON.stringify(visual)],
      });
    }
    next.visuals = { ...current.visuals, ...patch.visuals };
  }

  return next;
}

export async function setVisual(lessonId: string, visualId: string, visual: Visual): Promise<void> {
  await ensureSchema();
  await client.execute({
    sql: `INSERT OR REPLACE INTO visuals (lesson_id, id, json) VALUES (?, ?, ?)`,
    args: [lessonId, visualId, JSON.stringify(visual)],
  });
}
