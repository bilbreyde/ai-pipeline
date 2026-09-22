import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { MAX_TRANSCRIPT_CHARS, TranscriptError, docxXmlToText, extractTranscript, parseCaptions } from "../src/lib/transcript.js";

const VTT = `WEBVTT

NOTE this is a comment
that spans two lines

1
00:00:01.000 --> 00:00:04.000
<v Avery Stone>Thanks for joining today.</v>

2
00:00:04.500 --> 00:00:08.000
<v Avery Stone>We wanted to walk through the pricing.</v>

3
00:00:08.500 --> 00:00:12.000
<v Priya Rao>Budget is &amp; stays at $310,000 for phase one.</v>
`;

async function docx(paragraphsXml, extraFiles = {}) {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${paragraphsXml}</w:body></w:document>`);
  for (const [k, v] of Object.entries(extraFiles)) zip.file(k, v);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("captions: speakers are kept, cue noise is dropped, same speaker lines merge", () => {
  const out = parseCaptions(VTT);
  assert.equal(out, "Avery Stone: Thanks for joining today. We wanted to walk through the pricing.\nPriya Rao: Budget is & stays at $310,000 for phase one.");
});

test("captions: srt numbering and comma timestamps are dropped", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nAvery: Hello there.\n\n2\n00:00:03,500 --> 00:00:05,000\nPriya: Hi Avery.\n";
  assert.equal(parseCaptions(srt), "Avery: Hello there.\nPriya: Hi Avery.");
});

test("docx: paragraphs, tabs, breaks and entities", () => {
  const xml = '<w:p><w:r><w:t>Avery Stone</w:t><w:tab/><w:t>0:05</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Fish &amp; chips at $5 &#x26; more</w:t></w:r></w:p><w:p></w:p><w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r></w:p>';
  assert.equal(docxXmlToText(xml), "Avery Stone 0:05\nFish & chips at $5 & more\na\nb");
});

test("extract: pasted text is cleaned", async () => {
  const r = await extractTranscript({ text: "﻿Avery:   hello\r\n\r\n\r\n\r\nPriya: this is a longer line so it passes the minimum length" });
  assert.equal(r.source, "pasted text");
  assert.ok(!r.text.includes("\r"));
  assert.ok(!/\n\n\n/.test(r.text));
  assert.ok(r.text.startsWith("Avery: hello"));
});

test("extract: a real docx file", async () => {
  const buf = await docx("<w:p><w:r><w:t>Avery Stone 0:05 Thanks everyone for joining the call about Fabrikam.</w:t></w:r></w:p>");
  const r = await extractTranscript({ name: "call.docx", buffer: buf });
  assert.equal(r.source, "call.docx");
  assert.match(r.text, /Fabrikam/);
});

test("extract: a zip bomb docx is refused before it is unpacked", async () => {
  const bomb = "a".repeat(26 * 1024 * 1024);
  const buf = await docx(`<w:p><w:r><w:t>${bomb}</w:t></w:r></w:p>`);
  assert.ok(buf.length < 4 * 1024 * 1024, "the compressed file must be small for this test to mean anything");
  await assert.rejects(extractTranscript({ name: "x.docx", buffer: buf }), (e) => e instanceof TranscriptError && e.status === 413);
});

test("extract: vtt file, utf-16 text file", async () => {
  const r = await extractTranscript({ name: "meeting.vtt", buffer: Buffer.from(VTT) });
  assert.match(r.text, /^Avery Stone: Thanks/);
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Avery: this is a plain text transcript with enough words in it to pass.", "utf16le")]);
  assert.match((await extractTranscript({ name: "n.txt", buffer: u16 })).text, /^Avery: this is a plain/);
});

test("extract: friendly refusals", async () => {
  await assert.rejects(extractTranscript({ name: "a.pdf", buffer: Buffer.from("%PDF") }), /PDF is not supported/);
  await assert.rejects(extractTranscript({ name: "a.doc", buffer: Buffer.from("x") }), /\.docx/);
  await assert.rejects(extractTranscript({ name: "a.exe", buffer: Buffer.from("MZ") }), /not supported/);
  await assert.rejects(extractTranscript({ name: "a.txt", buffer: Buffer.from([1, 2, 0, 3]) }), /binary/);
  await assert.rejects(extractTranscript({ name: "a.docx", buffer: Buffer.from("not a zip at all") }), /does not look like a .docx/);
  await assert.rejects(extractTranscript({ text: "too short" }), /not enough text/);
  await assert.rejects(extractTranscript({}), /Paste the transcript/);
  await assert.rejects(extractTranscript({ text: "word ".repeat(MAX_TRANSCRIPT_CHARS / 4) }), (e) => e.status === 413 && /limit is 200,000/.test(e.message));
});
