export type Paper = {
  id: string;
  source: "arxiv" | "manual";
  title: string;
  authors: string[];
  abstract: string;
  pdfUrl: string;
  publishedAt?: string;
  url: string;
};

export type VisualSpec = {
  id: string;
  kind: "mermaid" | "katex" | "image" | "widget";
  title: string;
  description: string;
};

export type Visual =
  | (VisualSpec & { status: "pending" })
  | (VisualSpec & { status: "ready"; payload: string })
  | (VisualSpec & { status: "error"; error: string });

export type Section = {
  id: string;
  title: string;
  summary: string;
  keyPoints: string[];
  visualIds: string[];
};

export type LessonOutline = {
  title: string;
  hook: string;
  prerequisites: string[];
  sections: Section[];
};

export type LessonStatus = "queued" | "researching" | "planning" | "rendering" | "ready" | "error";

export type Lesson = {
  id: string;
  paper: Paper;
  status: LessonStatus;
  error?: string;
  outline?: LessonOutline;
  visuals: Record<string, Visual>;
  createdAt: number;
};
