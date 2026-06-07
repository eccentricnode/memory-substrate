#!/usr/bin/env bun
// memory-substrate validator — reference implementation
// Usage: bun reference/validator.ts <memory_root>
// Spec: SPEC.md v0.1.0-draft

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename, relative, dirname } from "node:path";

const VALID_TYPES = ["user", "feedback", "project", "reference"] as const;
type MemoryType = typeof VALID_TYPES[number];

const INDEX_LINE_CAP = 150;
const INDEX_BYTE_CAP = 25 * 1024;
const HOOK_LINE_CAP = 150;
const DESCRIPTION_CAP = 300;

type Severity = "error" | "warn" | "info";
type Finding = { severity: Severity; file: string; line?: number; msg: string };

const findings: Finding[] = [];
const push = (severity: Severity, file: string, msg: string, line?: number) =>
  findings.push({ severity, file, line, msg });

function parseFrontmatter(content: string): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
} {
  if (!content.startsWith("---\n")) {
    return { ok: false, error: "no frontmatter delimiter" };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return { ok: false, error: "unterminated frontmatter block" };
  const body = content.slice(4, end);
  const data: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};
  let inMetadata = false;
  for (const raw of body.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    // Detect block headers: `metadata:` (with optional trailing whitespace, no value)
    const blockHeader = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*$/);
    if (blockHeader && blockHeader[1] === "metadata") {
      inMetadata = true;
      continue;
    }
    const m = raw.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1] ?? "";
    const key = m[2];
    const value = m[3] ?? "";
    if (!key) continue;
    const isIndented = indent.length > 0;
    // Indented lines go into the most recently opened block (metadata).
    // Non-indented lines reset block context unless they're empty.
    if (!isIndented) inMetadata = false;
    const target = isIndented && inMetadata ? metadata : data;
    target[key] = value.replace(/^["']|["']$/g, "");
  }
  // Spec normalization: flat `type:` at top level is accepted as `metadata.type`.
  // This handles the historical PAI auto-memory shape where many files have
  // `type:` at root instead of nested under `metadata:`.
  if (data.type && !metadata.type) {
    metadata.type = data.type;
  }
  if (Object.keys(metadata).length > 0) data.metadata = metadata;
  return { ok: true, data };
}

function listMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const s = statSync(full);
      if (s.isDirectory()) {
        if (entry.startsWith(".")) continue;
        walk(full);
      } else if (entry.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function checkTopicFile(root: string, path: string) {
  const rel = relative(root, path);
  const content = readFileSync(path, "utf8");
  const fm = parseFrontmatter(content);
  if (!fm.ok) {
    push("error", rel, `frontmatter: ${fm.error}`);
    return;
  }
  const data = fm.data ?? {};
  if (!data.name) push("error", rel, "frontmatter missing `name`");
  if (!data.description) push("error", rel, "frontmatter missing `description`");
  else if ((data.description as string).length > DESCRIPTION_CAP)
    push(
      "warn",
      rel,
      `description ${(data.description as string).length} chars exceeds ${DESCRIPTION_CAP} cap`,
    );
  const md = data.metadata as Record<string, unknown> | undefined;
  if (!md || !md.type) {
    push("error", rel, "frontmatter missing `metadata.type`");
  } else if (!VALID_TYPES.includes(md.type as MemoryType)) {
    push(
      "error",
      rel,
      `metadata.type "${md.type}" not in [${VALID_TYPES.join(", ")}]`,
    );
  }
}

function checkIndex(root: string) {
  const indexPath = join(root, "MEMORY.md");
  if (!existsSync(indexPath)) {
    push("error", "MEMORY.md", "index file missing");
    return { entries: new Map<string, number>(), referenced: new Set<string>() };
  }
  const content = readFileSync(indexPath, "utf8");
  const lines = content.split("\n");
  const byteSize = Buffer.byteLength(content, "utf8");
  if (lines.length > INDEX_LINE_CAP)
    push(
      "warn",
      "MEMORY.md",
      `${lines.length} lines exceeds ${INDEX_LINE_CAP}-line cap`,
    );
  if (byteSize > INDEX_BYTE_CAP)
    push(
      "warn",
      "MEMORY.md",
      `${(byteSize / 1024).toFixed(1)} KB exceeds ${INDEX_BYTE_CAP / 1024} KB cap`,
    );

  const entries = new Map<string, number>();
  const referenced = new Set<string>();
  const entryRe = /^- \[([^\]]+)\]\(([^)]+)\)(.*)$/;
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const m = line.match(entryRe);
    if (!m) return;
    const target = m[2];
    const tail = m[3] ?? "";
    if (!target) return;
    entries.set(target, lineNo);
    referenced.add(target);
    if (line.length > HOOK_LINE_CAP)
      push(
        "warn",
        "MEMORY.md",
        `line ${line.length} chars exceeds ${HOOK_LINE_CAP}-char hook cap`,
        lineNo,
      );
    const targetPath = join(root, target);
    if (!existsSync(targetPath))
      push("error", "MEMORY.md", `broken link → ${target}`, lineNo);
    if (!tail.includes("—") && !tail.includes("--"))
      push(
        "info",
        "MEMORY.md",
        `entry missing em-dash hook: ${target}`,
        lineNo,
      );
  });
  return { entries, referenced };
}

function main() {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: bun reference/validator.ts <memory_root>");
    process.exit(2);
  }
  if (!existsSync(root)) {
    console.error(`memory_root does not exist: ${root}`);
    process.exit(2);
  }

  const files = listMarkdownFiles(root);
  const topicFiles = files.filter((f) => basename(f) !== "MEMORY.md");
  for (const f of topicFiles) checkTopicFile(root, f);
  const { referenced } = checkIndex(root);

  // Orphan check: topic files not referenced from MEMORY.md
  const referencedAbs = new Set(
    [...referenced].map((r) => join(root, r)),
  );
  for (const f of topicFiles) {
    if (!referencedAbs.has(f)) {
      push("warn", relative(root, f), "orphan: not referenced from MEMORY.md");
    }
  }

  // Summary
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  console.log("");
  console.log(`memory-substrate validator — ${root}`);
  console.log(
    `${topicFiles.length} topic files | ${counts.error} errors | ${counts.warn} warnings | ${counts.info} info`,
  );
  console.log("");

  const order: Severity[] = ["error", "warn", "info"];
  for (const sev of order) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    console.log(`=== ${sev.toUpperCase()} (${group.length}) ===`);
    for (const f of group) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  ${loc}  ${f.msg}`);
    }
    console.log("");
  }

  process.exit(counts.error > 0 ? 1 : 0);
}

main();
