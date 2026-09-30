import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractDocText } from "../src/lib/doc-extractor.js";

function makePptx(dir: string, slides: string[], notes: string[] = []): string {
  // Minimal OOXML: [Content_Types].xml + one slide part per slide.
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `</Types>`;
  const files: Record<string, string> = { "[Content_Types].xml": contentTypes };
  slides.forEach((body, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] =
      `<p:sld xmlns:p="x" xmlns:a="y"><p:cSld><p:spTree>` +
      body.split("\n").map(t => `<a:t>${t}</a:t>`).join("") +
      `</p:spTree></p:cSld></p:sld>`;
    if (notes[i]) {
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] =
        `<p:notes xmlns:p="x" xmlns:a="y"><a:t>${notes[i]}</a:t></p:notes>`;
    }
  });
  // Build the zip by hand (local file headers + central directory).
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const push32 = (arr: Uint8Array[], v: number) => {
    arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  };
  const push16 = (arr: Uint8Array[], v: number) => { arr.push(v & 0xff, (v >>> 8) & 0xff); };
  const names = Object.keys(files);
  for (const name of names) {
    const data = enc.encode(files[name]);
    const header: number[] = [];
    push32(header, 0x04034b50); push16(header, 20); push16(header, 0);
    push16(header, 0); push16(header, 0); push16(header, 0);
    push32(header, crc(data)); push32(header, data.length); push32(header, data.length);
    const nb = enc.encode(name);
    push16(header, nb.length); push16(header, 0);
    const hbytes = Uint8Array.from(header);
    const nbytes = Uint8Array.from(nb);
    chunks.push(hbytes, nbytes, data);
    const c: number[] = [];
    push32(c, 0x02014b50); push16(c, 20); push16(c, 20);
    push16(c, 0); push16(c, 0); push16(c, 0); push16(c, 0);
    push32(c, crc(data)); push32(c, data.length); push32(c, data.length);
    push16(c, nb.length); push16(c, 0); push16(c, 0); push16(c, 0); push16(c, 0);
    push32(c, 0); push32(c, offset);
    central.push(Uint8Array.from(c), nbytes);
    offset += hbytes.length + nbytes.length + data.length;
  }
  const centralStart = offset;
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end: number[] = [];
  push32(end, 0x06054b50); push16(end, 0); push16(end, 0);
  push16(end, names.length); push16(end, names.length);
  push32(end, centralSize); push32(end, centralStart); push16(end, 0);
  const out = Buffer.concat([...chunks, ...central, Uint8Array.from(end)].map(u => Buffer.from(u)));
  const p = join(dir, "deck.pptx");
  writeFileSync(p, out);
  return p;
}

describe("doc-extractor pptx", () => {
  it("extracts slide text + speaker notes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pptx-"));
    const p = makePptx(dir, ["Agentic systems overview\nAutomation to agents", "NeuroWorks architecture"], ["Remember the demo"]);
    const ex = await extractDocText(p);
    expect(ex.kind).toBe("pptx");
    expect(ex.text).toMatch(/Agentic systems overview/);
    expect(ex.text).toMatch(/Slide 2/);
    expect(ex.text).toMatch(/Remember the demo/);
  });

  it("handles XML entities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pptx-"));
    const p = makePptx(dir, ["R&amp;D &lt;budget&gt;"]);
    const ex = await extractDocText(p);
    expect(ex.text).toMatch(/R&D <budget>/);
  });
});
