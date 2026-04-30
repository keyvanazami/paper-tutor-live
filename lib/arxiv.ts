import type { Paper } from "@/types";

const ARXIV_API = "http://export.arxiv.org/api/query";

export async function searchArxiv(query: string, max = 5): Promise<Paper[]> {
  const url = `${ARXIV_API}?search_query=${encodeURIComponent(`all:${query}`)}&start=0&max_results=${max}&sortBy=relevance&sortOrder=descending`;
  const res = await fetch(url, { headers: { "User-Agent": "paper-tutor/0.1" } });
  if (!res.ok) throw new Error(`arXiv ${res.status}`);
  const xml = await res.text();
  return parseArxivFeed(xml);
}

function parseArxivFeed(xml: string): Paper[] {
  const entries = xml.split(/<entry>/).slice(1).map((s) => s.split(/<\/entry>/)[0]);
  return entries.map((entry) => {
    const idUrl = pick(entry, "id") ?? "";
    const id = idUrl.split("/abs/")[1] ?? idUrl;
    const pdfUrl = idUrl.replace("/abs/", "/pdf/");
    return {
      id,
      source: "arxiv" as const,
      title: clean(pick(entry, "title")),
      authors: pickAll(entry, "name"),
      abstract: clean(pick(entry, "summary")),
      pdfUrl,
      publishedAt: pick(entry, "published"),
      url: idUrl,
    };
  });
}

function pick(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}
function pickAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}
function clean(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export type PaperImage = {
  page: number;
  name: string;
  data: Uint8Array;
  ext: "png" | "jpg" | "webp" | "gif";
  width: number;
  height: number;
};

export type PaperContents = {
  text: string;
  images: PaperImage[];
};

function mimeToExt(dataUrl: string): PaperImage["ext"] | null {
  const m = dataUrl.match(/^data:image\/([^;]+);/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (mime === "png") return "png";
  if (mime === "jpeg" || mime === "jpg") return "jpg";
  if (mime === "webp") return "webp";
  if (mime === "gif") return "gif";
  return null; // unsupported by browsers (jp2, jbig2, etc.)
}

export async function fetchPaperContents(pdfUrl: string): Promise<PaperContents> {
  const res = await fetch(pdfUrl, { headers: { "User-Agent": "paper-tutor/0.1" } });
  if (!res.ok) throw new Error(`PDF ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data });
  try {
    const textResult = await parser.getText();
    let images: PaperImage[] = [];
    try {
      const imageResult = await parser.getImage();
      for (const page of imageResult.pages) {
        for (const img of page.images) {
          const ext = mimeToExt(img.dataUrl);
          if (!ext) continue;
          images.push({
            page: page.pageNumber,
            name: img.name,
            data: img.data,
            ext,
            width: img.width,
            height: img.height,
          });
        }
      }
    } catch (err) {
      // Image extraction is best-effort. Some PDFs (especially LaTeX papers
      // with vector figures and no embedded bitmaps) blow up pdfjs's worker
      // with "Cannot transfer object of unsupported type" — text still
      // succeeded, so don't fail the whole pipeline.
      console.warn(`[fetchPaperContents] image extraction failed:`, err);
      images = [];
    }
    return { text: textResult.text, images };
  } finally {
    await parser.destroy();
  }
}

// Backwards-compatible alias.
export async function fetchPdfText(pdfUrl: string): Promise<string> {
  return (await fetchPaperContents(pdfUrl)).text;
}
