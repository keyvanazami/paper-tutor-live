import { GoogleGenAI } from "@google/genai";

let cached: GoogleGenAI | undefined;

export function gemini(): GoogleGenAI {
  if (!cached) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
    cached = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return cached;
}

export const PLANNER_MODEL = process.env.PLANNER_MODEL ?? "gemini-3.1-pro-preview";
export const LIVE_MODEL = process.env.LIVE_MODEL ?? "gemini-live-2.5-flash-native-audio";
export const IMAGE_MODEL = process.env.IMAGE_MODEL ?? "gemini-3.1-flash-image-preview";
