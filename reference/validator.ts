#!/usr/bin/env bun
// memory-substrate validator — reference implementation
// Usage: bun reference/validator.ts <memory_root>
// Spec: SPEC.md v0.1.0-draft

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const VALID_TYPES = ["user", "feedback", "project", "reference"] as const;
type MemoryType = typeof VALID_TYPES[number];

const INDEX_LINE_CAP = 150;
const INDEX_BYTE_CAP = 25 * 1024;
const HOOK_LINE_CAP = 150;
const DESCRIPTION_CAP = 200;

export type Severity = "error" | "warn" | "info";
export type Finding = { severity: Severity; file: string; line?: number; msg: string };

export interface ValidationCounts {
  error: number;
  warn: number;
  info: number;
}

export interface ValidationReport {
  root: string;
  topicFileCount: number;
  findings: Finding[];
  counts: ValidationCounts;
}

interface ValidationContext {
  root: string;
  realRoot: string;
  findings: Finding[];
}

const push = (
  ctx: ValidationContext,
  severity: Severity,
  file: string,
  msg: string,
  line?: number,
) => ctx.findings.push({ severity, file, line, msg });

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

function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
  );
}

function listMarkdownFiles(ctx: ValidationContext): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(ctx.root, full);
      const lstat = lstatSync(full);
      let realFull: string;
      try {
        realFull = realpathSync(full);
      } catch (error) {
        push(
          ctx,
          "warn",
          rel,
          `cannot resolve path: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!isInsideRoot(ctx.realRoot, realFull)) {
        push(ctx, "error", rel, "path escapes memory root");
        continue;
      }
      const s = lstat.isSymbolicLink() ? statSync(full) : lstat;
      if (s.isDirectory()) {
        if (entry.startsWith(".")) continue;
        walk(full);
      } else if (entry.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  walk(ctx.root);
  return out;
}

function hasMarkdown(value: string): boolean {
  return /(`[^`]+`|\*\*?[^*]+\*\*?|__[^_]+__|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|^#{1,6}\s|<[^>\n]+>)/m.test(
    value,
  );
}

function expectedNameForPath(path: string, metadataType?: string): string {
  const stem = basename(path, ".md");
  if (metadataType && stem.startsWith(`${metadataType}_`)) {
    return stem.slice(metadataType.length + 1);
  }
  const typePrefix = VALID_TYPES.find((type) => stem.startsWith(`${type}_`));
  if (typePrefix) return stem.slice(typePrefix.length + 1);
  return stem;
}

function findWikiLinks(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]\n]+)\]\]/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

interface TopicCheckResult {
  path: string;
  name?: string;
  wikiLinks: string[];
}

function checkTopicFile(ctx: ValidationContext, path: string): TopicCheckResult {
  const rel = relative(ctx.root, path);
  const content = readFileSync(path, "utf8");
  const wikiLinks = findWikiLinks(content);
  const fm = parseFrontmatter(content);
  if (!fm.ok) {
    push(ctx, "error", rel, `frontmatter: ${fm.error}`);
    return { path, wikiLinks };
  }
  const data = fm.data ?? {};
  const name = typeof data.name === "string" ? data.name : undefined;
  const description =
    typeof data.description === "string" ? data.description : undefined;
  const md = data.metadata as Record<string, unknown> | undefined;
  const metadataType = typeof md?.type === "string" ? md.type : undefined;
  if (!name) {
    push(ctx, "error", rel, "frontmatter missing `name`");
  } else {
    const expectedName = expectedNameForPath(path, metadataType);
    if (name !== expectedName) {
      push(
        ctx,
        "error",
        rel,
        `frontmatter \`name\` must match filename stem \`${expectedName}\``,
      );
    }
  }
  if (!description) {
    push(ctx, "error", rel, "frontmatter missing `description`");
  } else {
    if (description.includes("\n")) {
      push(ctx, "error", rel, "description must be a single line");
    }
    if (hasMarkdown(description)) {
      push(ctx, "error", rel, "description must not contain markdown formatting");
    }
    if (description.length > DESCRIPTION_CAP) {
      push(
        ctx,
      "warn",
      rel,
        `description ${description.length} chars exceeds ${DESCRIPTION_CAP} cap`,
      );
    }
  }
  if (!md || !md.type) {
    push(ctx, "error", rel, "frontmatter missing `metadata.type`");
  } else if (!VALID_TYPES.includes(md.type as MemoryType)) {
    push(
      ctx,
      "error",
      rel,
      `metadata.type "${md.type}" not in [${VALID_TYPES.join(", ")}]`,
    );
  }

  return { path, name, wikiLinks };
}

function resolveIndexTarget(ctx: ValidationContext, target: string): string | undefined {
  if (target.trim() === "" || target.includes("\0") || isAbsolute(target)) {
    return undefined;
  }
  const resolved = resolve(ctx.root, target);
  if (!isInsideRoot(ctx.root, resolved)) return undefined;
  return resolved;
}

function checkIndex(ctx: ValidationContext) {
  const indexPath = join(ctx.root, "MEMORY.md");
  if (!existsSync(indexPath)) {
    push(ctx, "error", "MEMORY.md", "index file missing");
    return { entries: new Map<string, number>(), referenced: new Set<string>() };
  }
  const content = readFileSync(indexPath, "utf8");
  if (content.startsWith("---\n")) {
    push(ctx, "error", "MEMORY.md", "index must not have frontmatter");
  }
  const lines = content.split("\n");
  const byteSize = Buffer.byteLength(content, "utf8");
  if (lines.length > INDEX_LINE_CAP)
    push(
      ctx,
      "warn",
      "MEMORY.md",
      `${lines.length} lines exceeds ${INDEX_LINE_CAP}-line cap`,
    );
  if (byteSize > INDEX_BYTE_CAP)
    push(
      ctx,
      "warn",
      "MEMORY.md",
      `${(byteSize / 1024).toFixed(1)} KB exceeds ${INDEX_BYTE_CAP / 1024} KB cap`,
    );

  const entries = new Map<string, number>();
  const referenced = new Set<string>();
  const entryRe = /^- \[([^\]]+)\]\(([^)]+)\)(.*)$/;
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (
      trimmed === "" ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("<!--") ||
      trimmed === "---" ||
      /^[A-Za-z_][A-Za-z0-9_-]*:\s*/.test(trimmed)
    ) {
      return;
    }
    const m = line.match(entryRe);
    if (!m) {
      push(ctx, "error", "MEMORY.md", "invalid index entry line", lineNo);
      return;
    }
    const target = m[2];
    const tail = m[3] ?? "";
    if (!target) return;
    entries.set(target, lineNo);
    referenced.add(target);
    if (line.length > HOOK_LINE_CAP)
      push(
        ctx,
        "warn",
        "MEMORY.md",
        `line ${line.length} chars exceeds ${HOOK_LINE_CAP}-char hook cap`,
        lineNo,
      );
    const targetPath = resolveIndexTarget(ctx, target);
    if (!targetPath) {
      push(ctx, "error", "MEMORY.md", `link escapes memory root: ${target}`, lineNo);
      return;
    }
    if (!existsSync(targetPath)) {
      push(ctx, "error", "MEMORY.md", `broken link: ${target}`, lineNo);
    } else {
      const realTarget = realpathSync(targetPath);
      if (!isInsideRoot(ctx.realRoot, realTarget)) {
        push(ctx, "error", "MEMORY.md", `link escapes memory root: ${target}`, lineNo);
      }
    }
    if (!tail.includes("—") && !tail.includes("--"))
      push(
        ctx,
        "info",
        "MEMORY.md",
        `entry missing em-dash hook: ${target}`,
        lineNo,
      );
  });
  return { entries, referenced };
}

export function validateMemoryDirectory(root: string): ValidationReport {
  const ctx: ValidationContext = {
    root,
    realRoot: realpathSync(root),
    findings: [],
  };

  const files = listMarkdownFiles(ctx);
  const topicFiles = files.filter((f) => basename(f) !== "MEMORY.md");
  const topicResults = topicFiles.map((f) => checkTopicFile(ctx, f));
  const topicNames = new Set(
    topicResults.map((result) => result.name).filter((name): name is string => Boolean(name)),
  );
  for (const result of topicResults) {
    for (const wikiLink of result.wikiLinks) {
      if (!topicNames.has(wikiLink)) {
        push(
          ctx,
          "info",
          relative(ctx.root, result.path),
          `unresolved wiki link [[${wikiLink}]]`,
        );
      }
    }
  }
  const { referenced } = checkIndex(ctx);

  // Orphan check: topic files not referenced from MEMORY.md
  const referencedAbs = new Set(
    [...referenced].map((r) => resolve(ctx.root, r)),
  );
  for (const f of topicFiles) {
    if (!referencedAbs.has(resolve(f))) {
      push(ctx, "error", relative(ctx.root, f), "orphan: not referenced from MEMORY.md");
    }
  }

  const counts: ValidationCounts = { error: 0, warn: 0, info: 0 };
  for (const f of ctx.findings) counts[f.severity]++;
  return {
    root,
    topicFileCount: topicFiles.length,
    findings: ctx.findings,
    counts,
  };
}

function printReport(report: ValidationReport): void {
  console.log("");
  console.log(`memory-substrate validator — ${report.root}`);
  console.log(
    `${report.topicFileCount} topic files | ${report.counts.error} errors | ${report.counts.warn} warnings | ${report.counts.info} info`,
  );
  console.log("");

  const order: Severity[] = ["error", "warn", "info"];
  for (const sev of order) {
    const group = report.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    console.log(`=== ${sev.toUpperCase()} (${group.length}) ===`);
    for (const f of group) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  ${loc}  ${f.msg}`);
    }
    console.log("");
  }
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

  const report = validateMemoryDirectory(root);
  printReport(report);
  process.exit(report.counts.error > 0 ? 1 : 0);
}

if (import.meta.main) main();
