// ─────────────────────────────────────────────────────────────────────────────
// INGEST: turn the handbook PDF into a searchable index.
//
//   npm run ingest              → reads the PDF, splits it into citable blocks
//                                 by section, and writes data/handbook-index.json
//   npm run ingest -- --dry-run → same, but only prints what it found so you
//                                 can check the sections. Nothing is saved.
//
// No API key needed: this step runs entirely on your computer.
//
// Run this again whenever the handbook PDF changes, then commit the new
// data/handbook-index.json. The website only ever reads that file.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { CONFIG } from "../lib/config";
import type { HandbookChunk, HandbookIndex } from "../lib/types";
import { HANDBOOK_PARTS, SKIP_PAGES_THROUGH } from "./handbook-sections";

const DRY_RUN = process.argv.includes("--dry-run");

// Block sizing: long sections are split into blocks of about this many
// characters, so a citation points at a specific passage, not a whole page.
const TARGET_CHARS = 900;

type Line = { text: string; page: number };
type Section = { part: string; section: string; lines: Line[] };

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Compare headings loosely: case, curly quotes, stray spaces. */
function norm(s: string): string {
  return s
    .replace(/[​﻿]/g, "") // invisible zero-width characters in the PDF
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isAllCaps(s: string): boolean {
  return /[A-Z]/.test(s) && s === s.toUpperCase();
}

/** "CAMPUS HOUSING RULES AND REGULATIONS" → "Campus Housing Rules and Regulations" */
function titleCase(s: string): string {
  const small = new Set(["and", "of", "the", "for", "with", "in", "to", "at"]);
  const keepUpper = new Set(["REHS", "RHS", "MSU", "(RCPD)", "RCPD", "18"]);
  return s
    .split(" ")
    .map((word, i) => {
      if (keepUpper.has(word)) return word;
      const lower = word.toLowerCase();
      if (i > 0 && small.has(lower)) return lower;
      return lower.replace(/(^|-)([a-z])/g, (_, dash, ch) => dash + ch.toUpperCase());
    })
    .join(" ");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Page footers like "MICHIGAN STATE UNIVERSITY | 15" are not content. */
function isFooter(line: string): boolean {
  return /^MICHIGAN STATE UNIVERSITY \| \d+$/.test(line) || /^\d+ \| LIVING IN THE RESIDENCE HALLS$/.test(line);
}

/** Join wrapped PDF lines back into readable text, keeping bullet points on their own lines. */
function linesToText(lines: Line[]): string {
  let out = "";
  for (const { text } of lines) {
    if (out === "") out = text;
    else if (text.startsWith("•")) out += "\n" + text;
    else if (out.endsWith("-") && /^[a-z]/.test(text)) out += text; // re-join "on-" + "campus"
    else out += " " + text;
  }
  return out.replace(/[​﻿]/g, "").trim();
}

// ── Step 1: read the PDF ────────────────────────────────────────────────────

async function readPdfLines(path: string): Promise<{ lines: Line[]; sha256: string }> {
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text: pages } = await extractText(pdf, { mergePages: false });

  const lines: Line[] = [];
  pages.forEach((pageText, i) => {
    const page = i + 1; // this handbook's printed page numbers match the PDF pages
    if (page <= SKIP_PAGES_THROUGH) return;
    for (const raw of pageText.split("\n")) {
      const text = raw.trim();
      if (text && !isFooter(text)) lines.push({ text, page });
    }
  });
  return { lines, sha256 };
}

// ── Step 2: split into sections using the Table of Contents headings ───────

function splitIntoSections(lines: Line[]): { sections: Section[]; missing: string[] } {
  const partByName = new Map(HANDBOOK_PARTS.map((p) => [norm(p.title), p]));
  const found = new Set<string>();

  let currentPart = HANDBOOK_PARTS[0];
  let current: Section = { part: titleCase(currentPart.title), section: titleCase(currentPart.title), lines: [] };
  const sections: Section[] = [current];

  const startSection = (part: string, section: string) => {
    current = { part, section, lines: [] };
    sections.push(current);
  };

  // Is this text a heading? Top-level headings are ALL CAPS in the PDF;
  // subsection headings are Title Case and must belong to the current part.
  const matchHeading = (text: string) => {
    if (isAllCaps(text)) {
      const part = partByName.get(norm(text));
      if (part) return { kind: "part" as const, part };
    } else {
      const sub = currentPart.subsections.find((s) => norm(s) === norm(text));
      if (sub) return { kind: "sub" as const, sub };
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    // Headings sometimes wrap onto a second line, so try two lines first.
    const twoLines = i + 1 < lines.length ? lines[i].text + " " + lines[i + 1].text : null;
    let hit = twoLines ? matchHeading(twoLines) : null;
    let consumed = hit ? 2 : 1;
    if (!hit) hit = matchHeading(lines[i].text);

    if (!hit) {
      current.lines.push(lines[i]);
      continue;
    }

    if (hit.kind === "part") {
      currentPart = hit.part;
      found.add(norm(hit.part.title));
      startSection(titleCase(hit.part.title), titleCase(hit.part.title));
    } else {
      found.add(norm(currentPart.title) + " > " + norm(hit.sub));
      startSection(titleCase(currentPart.title), hit.sub);
    }
    i += consumed - 1;
  }

  const missing: string[] = [];
  for (const part of HANDBOOK_PARTS) {
    if (part.title !== "INTRODUCTION" && !found.has(norm(part.title))) missing.push(part.title);
    for (const sub of part.subsections) {
      if (!found.has(norm(part.title) + " > " + norm(sub))) missing.push(`${part.title} > ${sub}`);
    }
  }

  return { sections: sections.filter((s) => s.lines.length > 0), missing };
}

// ── Step 3: cut long sections into citable blocks ──────────────────────────

function chunkSection(section: Section): HandbookChunk[] {
  const windows: Line[][] = [];
  let start = 0;
  while (start < section.lines.length) {
    let end = start;
    let size = 0;
    while (end < section.lines.length && (size < TARGET_CHARS || end === start)) {
      size += section.lines[end].text.length + 1;
      end++;
    }
    windows.push(section.lines.slice(start, end));
    start = end;
  }

  const base = `${slug(section.part)}--${slug(section.section)}`;
  return windows.map((w, n) => ({
    id: `${base}-${n + 1}`,
    part: section.part,
    section: section.section,
    pageStart: w[0].page,
    pageEnd: w[w.length - 1].page,
    text: linesToText(w),
  }));
}

// ── Step 4: save ────────────────────────────────────────────────────────────

async function main() {
  console.log(`Reading ${CONFIG.handbookPdfPath} ...`);
  const { lines, sha256 } = await readPdfLines(CONFIG.handbookPdfPath);
  const { sections, missing } = splitIntoSections(lines);
  const chunks = sections.flatMap(chunkSection);

  console.log(`\nFound ${sections.length} sections → ${chunks.length} chunks:\n`);
  for (const s of sections) {
    const n = chunks.filter((c) => c.part === s.part && c.section === s.section).length;
    console.log(`  p.${String(s.lines[0].page).padEnd(3)} ${s.part} › ${s.section}  (${n} chunk${n > 1 ? "s" : ""})`);
  }
  if (missing.length) {
    console.log(`\n⚠️  ${missing.length} heading(s) from handbook-sections.ts were not found in the PDF:`);
    for (const m of missing) console.log(`     - ${m}`);
    console.log("   Their text will be filed under the previous heading. Check the spelling against the PDF.");
  }

  if (DRY_RUN) {
    const id = process.argv[process.argv.indexOf("--dry-run") + 1];
    const show = chunks.find((c) => c.id === id);
    if (show) console.log(`\n── ${show.id} ──\n${show.text}`);
    console.log("\nDry run: nothing saved.");
    return;
  }

  const index: HandbookIndex = {
    handbookTitle: CONFIG.handbookTitle,
    sourceFile: CONFIG.handbookPdfPath,
    sourceSha256: sha256,
    builtAt: new Date().toISOString(),
    chunks,
  };

  mkdirSync(dirname(CONFIG.indexPath), { recursive: true });
  writeFileSync(CONFIG.indexPath, JSON.stringify(index, null, 1));
  console.log(`\n✅ Wrote ${CONFIG.indexPath} (${chunks.length} chunks). Commit this file.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
