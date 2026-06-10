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

interface MarkdownLink {
  target: string;
  line: number;
}

function lineForOffset(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function isOffsetInFencedCode(content: string, offset: number): boolean {
  let inFence = false;
  let currentOffset = 0;
  for (const line of content.split("\n")) {
    const lineEndOffset = currentOffset + line.length;
    if (offset >= currentOffset && offset <= lineEndOffset) return inFence;
    if (/^ {0,3}(?:```|~~~)/.test(line)) inFence = !inFence;
    currentOffset = lineEndOffset + 1;
  }
  return inFence;
}

function normalizeMarkdownTarget(target: string): string {
  const trimmed = target.trim();
  const angleMatch = trimmed.match(/^<([^>\n]*)>(?:\s+["'][^"']*["'])?$/);
  if (angleMatch) return angleMatch[1] ?? "";
  return trimmed.replace(/\s+["'][^"']*["']\s*$/, "");
}

function findMarkdownLinks(content: string): MarkdownLink[] {
  return [...content.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)]
    .filter((match) => !isOffsetInFencedCode(content, match.index ?? 0))
    .map((match) => ({
      target: normalizeMarkdownTarget(match[1] ?? ""),
      line: lineForOffset(content, match.index ?? 0),
    }))
    .filter((link) => link.target.length > 0);
}

function isExternalLink(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target);
}

function stripMarkdownFragment(target: string): string {
  return target.split("#", 1)[0] ?? target;
}

function checkLocalMarkdownLink(
  ctx: ValidationContext,
  sourceRel: string,
  sourceDir: string,
  target: string,
  line: number,
): void {
  if (isExternalLink(target)) return;
  const pathOnly = stripMarkdownFragment(target);
  if (pathOnly.trim() === "" || pathOnly.includes("\0") || isAbsolute(pathOnly)) {
    push(ctx, "error", sourceRel, `link escapes memory root: ${target}`, line);
    return;
  }
  const resolved = resolve(sourceDir, pathOnly);
  if (!isInsideRoot(ctx.realRoot, resolved)) {
    push(ctx, "error", sourceRel, `link escapes memory root: ${target}`, line);
    return;
  }
  if (!existsSync(resolved)) {
    push(ctx, "error", sourceRel, `broken link: ${target}`, line);
    return;
  }
  const realTarget = realpathSync(resolved);
  if (!isInsideRoot(ctx.realRoot, realTarget)) {
    push(ctx, "error", sourceRel, `link escapes memory root: ${target}`, line);
  }
}

interface TopicCheckResult {
  path: string;
  name?: string;
  wikiLinks: string[];
}

function isKebabCaseSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function checkTopicFile(ctx: ValidationContext, path: string): TopicCheckResult {
  const rel = relative(ctx.root, path);
  const content = readFileSync(path, "utf8");
  const wikiLinks = findWikiLinks(content);
  const markdownLinks = findMarkdownLinks(content);
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
    if (!isKebabCaseSlug(name)) {
      push(ctx, "error", rel, "frontmatter `name` must be a kebab-case slug");
    }
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
  if (typeof data.type === "string") {
    push(ctx, "error", rel, "frontmatter `type` must be nested under `metadata.type`");
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
  for (const link of markdownLinks) {
    checkLocalMarkdownLink(ctx, rel, resolve(path, ".."), link.target, link.line);
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
  const linkEntryRe = /^- \[([^\]]+)\]\(([^)]+)\)(.*)$/;
  const canonicalEntryRe = /^- \[([^\]]+)\]\(([^)]+)\) — (.+)$/;
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
    const linkMatch = line.match(linkEntryRe);
    if (!linkMatch) {
      push(ctx, "error", "MEMORY.md", "invalid index entry line", lineNo);
      return;
    }
    const canonicalMatch = line.match(canonicalEntryRe);
    const target = normalizeMarkdownTarget(linkMatch[2] ?? "");
    if (!target) return;
    if (!canonicalMatch) {
      push(ctx, "error", "MEMORY.md", "invalid index entry line", lineNo);
    } else {
      entries.set(target, lineNo);
      referenced.add(target);
    }
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
      } else if (basename(targetPath) === "MEMORY.md") {
        push(
          ctx,
          "error",
          "MEMORY.md",
          `index target must reference a topic file: ${target}`,
          lineNo,
        );
      } else if (!targetPath.endsWith(".md")) {
        push(
          ctx,
          "error",
          "MEMORY.md",
          `index target must be a markdown file: ${target}`,
          lineNo,
        );
      } else if (!statSync(targetPath).isFile()) {
        push(ctx, "error", "MEMORY.md", `index target must be a file: ${target}`, lineNo);
      }
    }
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
  const firstTopicByNormalizedName = new Map<string, TopicCheckResult>();
  for (const result of topicResults) {
    if (!result.name) continue;
    const normalizedName = normalizeSlug(result.name);
    if (!normalizedName) continue;
    const first = firstTopicByNormalizedName.get(normalizedName);
    if (first) {
      push(
        ctx,
        "error",
        relative(ctx.root, result.path),
        `duplicate topic name after slug normalization: ${normalizedName} already used by ${relative(ctx.root, first.path)}`,
      );
    } else {
      firstTopicByNormalizedName.set(normalizedName, result);
    }
  }
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
