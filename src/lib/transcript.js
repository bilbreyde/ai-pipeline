// Turns an uploaded transcript into plain text. Supports pasted text, .txt, .md, .vtt, .srt and .docx.
// Nothing here calls a model or stores anything. Errors are TranscriptError, whose message is safe to show the person.

export const MAX_TRANSCRIPT_CHARS = 200_000;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DOCX_XML_BYTES = 25 * 1024 * 1024; // guard against a zip bomb: the compressed file is capped at 4 MB, the XML inside is not

export class TranscriptError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "TranscriptError";
    this.status = status;
  }
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s) =>
  s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (_, hex, dec, name) => {
    if (name) return XML_ENTITIES[name];
    const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
  });

/** Collapse noise so the model sees content, and so the limit counts real text. */
export function cleanText(text) {
  return String(text)
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return new TextDecoder("utf-16le").decode(swapped);
  }
  if (buf.includes(0)) throw new TranscriptError("That looks like a binary file, not a transcript. Use .txt, .vtt or .docx, or paste the text.");
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * WebVTT and SRT: drop the header, cue numbers and timestamps, keep "Speaker: text",
 * and merge consecutive lines from the same speaker so the transcript stays compact.
 */
export function parseCaptions(raw) {
  const lines = cleanText(raw).split("\n");
  const out = [];
  let last = null;
  let inNote = false;
  for (let line of lines) {
    line = line.trim();
    if (line === "") { inNote = false; continue; }
    if (inNote) continue;
    if (/^WEBVTT/i.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(line)) { inNote = true; continue; }
    if (/-->/.test(line)) continue;
    if (/^\d+$/.test(line)) continue; // SRT cue number
    let speaker = null;
    const v = /^<v(?:\.[^ >]*)?\s+([^>]+)>/.exec(line);
    if (v) speaker = decodeXml(v[1]).trim();
    let text = decodeXml(line.replace(/<[^>]+>/g, "")).trim();
    if (!text) continue;
    if (!speaker) {
      const m = /^([^:]{1,60}):\s+(\S.*)$/.exec(text); // "Name: text" style captions
      if (m && !/^\d/.test(m[1])) { speaker = m[1].trim(); text = m[2]; }
    }
    if (speaker && speaker === last && out.length) out[out.length - 1].text += " " + text;
    else { out.push({ speaker, text }); last = speaker; }
  }
  return out.map((c) => (c.speaker ? `${c.speaker}: ${c.text}` : c.text)).join("\n");
}

/** Pull paragraph text out of word/document.xml. Tables become one paragraph per cell, which reads fine for a transcript. */
export function docxXmlToText(xml) {
  const paras = [];
  const re = /<w:p[ >][\s\S]*?<\/w:p>/g;
  for (const p of xml.match(re) ?? []) {
    let text = "";
    const tok = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
    let m;
    while ((m = tok.exec(p))) {
      if (m[1] !== undefined) text += decodeXml(m[1]);
      else if (m[0].startsWith("<w:tab")) text += " ";
      else text += "\n";
    }
    paras.push(text.trim());
  }
  return paras.filter((t) => t !== "").join("\n");
}

async function docxToText(buf) {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new TranscriptError("That does not look like a .docx file. Older .doc files are not supported, so save it as .docx.");
  }
  const { default: JSZip } = await import("jszip");
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new TranscriptError("That .docx file could not be opened. It may be damaged.");
  }
  const entry = zip.file("word/document.xml");
  if (!entry) throw new TranscriptError("That .docx file has no document body. Is it a Word document?");
  const declared = entry._data?.uncompressedSize;
  if (typeof declared !== "number" || declared > MAX_DOCX_XML_BYTES) {
    throw new TranscriptError("That .docx file is too large to read safely.", 413);
  }
  return docxXmlToText(await entry.async("string"));
}

/**
 * input: { text } or { name, buffer }. Returns { text, source } where source is the file name or "pasted text".
 * Throws TranscriptError for anything the person can fix.
 */
export async function extractTranscript({ text, name, buffer }) {
  let out;
  let source;
  if (typeof text === "string" && !buffer) {
    out = cleanText(text);
    source = "pasted text";
  } else if (buffer) {
    if (buffer.length > MAX_FILE_BYTES) throw new TranscriptError("That file is larger than 4 MB.", 413);
    const fname = String(name ?? "").trim().slice(0, 120);
    const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(fname)?.[1] ?? "").toLowerCase();
    source = fname || "uploaded file";
    if (ext === "docx") out = cleanText(await docxToText(buffer));
    else if (ext === "vtt" || ext === "srt") out = parseCaptions(decodeBuffer(buffer));
    else if (ext === "txt" || ext === "md" || ext === "text" || ext === "") out = cleanText(decodeBuffer(buffer));
    else if (ext === "pdf") throw new TranscriptError("PDF is not supported. Save the transcript as .docx or .txt, or paste the text.");
    else if (ext === "doc") throw new TranscriptError("Old .doc files are not supported. Save it as .docx, or paste the text.");
    else throw new TranscriptError(`.${ext} files are not supported. Use .txt, .vtt, .srt or .docx, or paste the text.`);
  } else {
    throw new TranscriptError("Paste the transcript text or choose a file.");
  }
  if (out.length < 40) throw new TranscriptError("There is not enough text there to analyse. A transcript needs at least a few sentences.");
  if (out.length > MAX_TRANSCRIPT_CHARS) {
    throw new TranscriptError(
      `That transcript is ${out.length.toLocaleString("en-US")} characters and the limit is ${MAX_TRANSCRIPT_CHARS.toLocaleString("en-US")}. Trim small talk or split it into two parts.`,
      413,
    );
  }
  return { text: out, source };
}
