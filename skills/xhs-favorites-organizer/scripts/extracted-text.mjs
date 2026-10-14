import { evidenceText, readEvidence } from "./evidence-files.mjs";

const TRANSCRIPT = { status: "transcribed", method: "local_transcription" };
const PICTURE_TEXT = { status: "extracted", method: "local_image_ocr" };

// The text the reader engine took out of a post's media, exactly as extracted (never rewritten).
// A video gives its transcript followed by any on-screen text; an image post gives its picture text.
// Returns { kind, text } or null.
export function loadExtractedText(videoAnalysisRoot, noteId, mediaType) {
  const spoken = evidenceText(readEvidence(videoAnalysisRoot, noteId, "transcription.json"), TRANSCRIPT)?.text || "";
  const onScreen = evidenceText(readEvidence(videoAnalysisRoot, noteId, "visual-ocr.json"), PICTURE_TEXT)?.text || "";
  if (mediaType === "图文") return onScreen ? { kind: "image-text", text: onScreen } : null;
  const text = [spoken, onScreen].filter(Boolean).join("\n\n");
  return text ? { kind: "video-transcript", text } : null;
}
