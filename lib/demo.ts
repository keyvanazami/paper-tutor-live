import type { LessonOutline, Paper, Visual, VisualSpec } from "@/types";

// Hand-curated lesson so you can hit the UI + realtime loop without paying for
// the planner LLM or waiting on PDF download. Mermaid/KaTeX are pre-baked
// (status: ready); the one image visual still hits the image API end-to-end.

export const DEMO_PAPER: Paper = {
  id: "1706.03762",
  source: "arxiv",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit", "Llion Jones", "Aidan N. Gomez", "Łukasz Kaiser", "Illia Polosukhin"],
  abstract:
    "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.",
  pdfUrl: "https://arxiv.org/pdf/1706.03762",
  url: "https://arxiv.org/abs/1706.03762",
  publishedAt: "2017-06-12",
};

export const DEMO_OUTLINE: LessonOutline = {
  title: "How transformers actually attend",
  hook:
    "Before transformers, language models read words one at a time, like reading with a finger. Attention let them read every word at once and decide which ones to look at — and that's the whole game.",
  prerequisites: ["matrix multiplication", "softmax intuition", "vector dot product"],
  sections: [
    {
      id: "s1",
      title: "The bottleneck before attention",
      summary:
        "Recurrent networks process tokens sequentially: each step depends on the last. That makes long-range dependencies fragile and training un-parallelizable.",
      keyPoints: [
        "RNNs read left-to-right, one token at a time",
        "Information from token 1 is squeezed through every subsequent step",
        "You can't parallelize across the sequence — wall-clock training scales linearly with length",
      ],
      visualIds: ["v1"],
    },
    {
      id: "s2",
      title: "Query, key, value",
      summary:
        "Attention reframes 'which earlier word should I look at?' as a lookup. Every token emits three vectors: a query (what am I looking for?), a key (what do I offer?), and a value (what do I contribute if matched?).",
      keyPoints: [
        "Query · Key gives a similarity score per pair",
        "Softmax over scores produces attention weights",
        "Output is the weighted sum of values",
      ],
      visualIds: ["v2"],
    },
    {
      id: "s3",
      title: "Scaled dot-product attention",
      summary:
        "All of attention compresses into one equation. The √dₖ scaling keeps the softmax from saturating when keys get high-dimensional.",
      keyPoints: [
        "QKᵀ is one big matrix multiply across the whole sequence",
        "Divide by √dₖ to control variance",
        "Softmax row-wise, then multiply by V",
      ],
      visualIds: ["v3", "v6"],
    },
    {
      id: "s4",
      title: "Multi-head attention",
      summary:
        "One attention pass collapses information into a single weighted view. Multi-head splits the query/key/value space into h smaller subspaces and attends in parallel — each head can specialize on a different relationship.",
      keyPoints: [
        "Each head has its own learned projection",
        "Heads run in parallel, then concat",
        "Different heads end up tracking syntax, coreference, position, etc.",
      ],
      visualIds: ["v4"],
    },
    {
      id: "s5",
      title: "Why this scales",
      summary:
        "Removing recurrence isn't just elegant — it unlocks the GPU. Every position attends to every other position in O(1) sequential ops. The cost is O(n²) memory in sequence length, which is what every long-context paper since has been trying to fix.",
      keyPoints: [
        "Sequential ops: O(1) for transformers vs O(n) for RNNs",
        "Quadratic memory in sequence length is the new bottleneck",
        "Subsequent work (sparse attention, linear attention, FlashAttention) targets this directly",
      ],
      visualIds: ["v5"],
    },
  ],
};

export const DEMO_VISUAL_SPECS: VisualSpec[] = [
  { id: "v1", kind: "mermaid", title: "RNN sequential vs Transformer parallel", description: "Top row: RNN reads tokens one at a time. Bottom row: Transformer attends to all tokens at once." },
  { id: "v2", kind: "mermaid", title: "Query/Key/Value flow", description: "Each input token produces Q, K, V; Q·Kᵀ → softmax → weights · V → output." },
  { id: "v3", kind: "katex", title: "Scaled dot-product attention", description: "The full attention equation." },
  { id: "v4", kind: "mermaid", title: "Multi-head attention", description: "Input splits into h heads in parallel, each runs scaled dot-product attention, then outputs concat and project." },
  { id: "v5", kind: "image", title: "Why transformers scale on GPUs", description: "A friendly diagram-style illustration: a single sequential reader (slow) on the left, contrasted with many parallel readers all looking at the same passage simultaneously on the right. Conveys parallelism vs sequential dependency. No text labels." },
  { id: "v6", kind: "widget", title: "Softmax sandbox", description: "An interactive widget with four range sliders labelled 'logit 1' through 'logit 4', each spanning -5 to +5. Below the sliders, four horizontal bars show the softmax probabilities of those logits, updating live as the user drags. Each bar shows its probability as a percentage. Include a small caption: 'Drag the sliders. Watch how exponentiation makes the largest logit dominate.'" },
];

// Pre-baked payloads keyed by visual id. The "image" visual is intentionally
// missing — it should be generated live to demonstrate the image gen path.
export const DEMO_VISUAL_PAYLOADS: Record<string, string> = {
  v1: `flowchart LR
  subgraph RNN["RNN (sequential)"]
    direction LR
    R1[The] --> R2[cat] --> R3[sat] --> R4[on] --> R5[the] --> R6[mat]
  end
  subgraph TRX["Transformer (parallel)"]
    direction LR
    T1[The]
    T2[cat]
    T3[sat]
    T4[on]
    T5[the]
    T6[mat]
    T1 <--> T2
    T1 <--> T3
    T1 <--> T6
    T2 <--> T3
    T3 <--> T6
  end`,
  v2: `flowchart LR
  X[Input token] --> Q[Query]
  X --> K[Key]
  X --> V[Value]
  Q --> S["Q · Kᵀ"]
  K --> S
  S --> W[softmax weights]
  W --> O["weighted sum of V"]
  V --> O
  O --> Y[Output token]`,
  v3: `\\text{Attention}(Q, K, V) = \\text{softmax}\\!\\left(\\frac{Q K^{\\top}}{\\sqrt{d_k}}\\right) V`,
  v4: `flowchart TD
  X[Input] --> P1[head 1: Q1 K1 V1]
  X --> P2[head 2: Q2 K2 V2]
  X --> P3[head h: Qh Kh Vh]
  P1 --> A1[attention 1]
  P2 --> A2[attention 2]
  P3 --> Ah[attention h]
  A1 --> C[concat]
  A2 --> C
  Ah --> C
  C --> O[output projection]`,
};

export function buildDemoVisuals(): Record<string, Visual> {
  return Object.fromEntries(
    DEMO_VISUAL_SPECS.map((spec): [string, Visual] => {
      const baked = DEMO_VISUAL_PAYLOADS[spec.id];
      if (baked) return [spec.id, { ...spec, status: "ready", payload: baked }];
      return [spec.id, { ...spec, status: "pending" }];
    }),
  );
}

export function pendingDemoImageSpecs(): VisualSpec[] {
  return DEMO_VISUAL_SPECS.filter((s) => !DEMO_VISUAL_PAYLOADS[s.id]);
}
