#!/usr/bin/env bun
// memory-substrate compactor — reference implementation
// Usage: bun reference/compactor.ts <memory_root> [output_dir]
// Spec: SPEC.md v0.1.0-draft §5.3 / §7

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  validateMemoryDirectory,
  type Finding as ValidatorFinding,
} from "./validator.ts";

const INDEX_LINE_CAP = 150;
const INDEX_BYTE_CAP = 25 * 1024;
const HOOK_CAP = 150;

export type CompactionFindingKind =
  | "validator-finding"
  | "duplicate-index-entry"
  | "broken-index-entry"
  | "long-index-line"
  | "orphan-topic"
  | "index-cap"
  | "topic-frontmatter";

export interface CompactionFinding {
  kind: CompactionFindingKind;
  file: string;
  line?: number;
  severity: "info" | "warn" | "error";
  message: string;
}

export interface CompactionReport {
  root: string;
  outputDir: string;
  topicFileCount: number;
  originalIndexLineCount: number;
  proposedIndexLineCount: number;
  originalIndexBytes: number;
  proposedIndexBytes: number;
  findings: CompactionFinding[];
  writtenFiles: string[];
}

export interface CompactMemoryDirectoryOptions {
  outputDir?: string;
  force?: boolean;
  allowInsideRoot?: boolean;
}

interface TopicSummary {
  relativePath: string;
  name: string;
  title: string;
  description: string;
  type: string;
}

interface IndexEntry {
  target: string;
  line: number;
  raw: string;
}

function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
  );
}

function defaultOutputDir(root: string): string {
  return `${resolve(root)}.compaction`;
}

function readIndex(root: string): string {
  const path = join(root, "MEMORY.md");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function oneLine(value: string, cap: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= cap) return line;
  return line.slice(0, cap - 1).trimEnd();
}

function titleize(value: string): string {
  const stem = basename(value, ".md").replace(/^(user|feedback|project|reference)_/, "");
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  type?: string;
} {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const frontmatter = content.slice(4, end);
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter
    .match(/^description:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  const type = frontmatter.match(/^\s*type:\s*(.+)$/m)?.[1]?.trim();
  return { name, description, type };
}

function listMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  const realRoot = realpathSync(root);
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const path = join(dir, entry);
      const stats = statSync(path);
      const realPath = realpathSync(path);
      if (!isInsideRoot(realRoot, realPath)) continue;
      if (stats.isDirectory()) {
        stack.push(path);
      } else if (entry.endsWith(".md")) {
        out.push(path);
      }
    }
  }
  return out.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

function collectTopics(root: string, findings: CompactionFinding[]): TopicSummary[] {
  return listMarkdownFiles(root)
    .filter((path) => basename(path) !== "MEMORY.md")
    .flatMap((path) => {
      const relativePath = relative(root, path).split(sep).join("/");
      const content = readFileSync(path, "utf8");
      const frontmatter = parseFrontmatter(content);
      const description = frontmatter.description;
      if (!description) {
        findings.push({
          kind: "topic-frontmatter",
          file: relativePath,
          severity: "error",
          message: "topic is missing a description, so the compactor cannot create a safe index hook",
        });
        return [];
      }
      return [
        {
          relativePath,
          name: frontmatter.name ?? basename(path, ".md"),
          title: titleize(relativePath),
          description: oneLine(description, HOOK_CAP),
          type: frontmatter.type ?? "unknown",
        },
      ];
    });
}

function parseIndexEntries(index: string): IndexEntry[] {
  return index
    .split(/\r?\n/)
    .flatMap((line, indexLine) => {
      const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\)\s*(?:—|--)?\s*(.*)$/);
      if (!match) return [];
      const title = match[1];
      const target = match[2];
      if (!title || !target) return [];
      return [
        {
          target,
          line: indexLine + 1,
          raw: line,
        },
      ];
    });
}

function collectIndexFindings(
  index: string,
  topics: TopicSummary[],
  validatorFindings: ValidatorFinding[],
): CompactionFinding[] {
  const findings: CompactionFinding[] = validatorFindings.map((finding) => ({
    kind: "validator-finding",
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    message: finding.msg,
  }));
  const entries = parseIndexEntries(index);
  const seen = new Set<string>();
  const topicPaths = new Set(topics.map((topic) => topic.relativePath));
  for (const entry of entries) {
    if (seen.has(entry.target)) {
      findings.push({
        kind: "duplicate-index-entry",
        file: "MEMORY.md",
        line: entry.line,
        severity: "warn",
        message: `duplicate pointer to ${entry.target}; the proposal keeps one canonical line`,
      });
    }
    seen.add(entry.target);
    if (!topicPaths.has(entry.target)) {
      findings.push({
        kind: "broken-index-entry",
        file: "MEMORY.md",
        line: entry.line,
        severity: "warn",
        message: `pointer target ${entry.target} is absent; the proposal omits it`,
      });
    }
    if (entry.raw.length > HOOK_CAP) {
      findings.push({
        kind: "long-index-line",
        file: "MEMORY.md",
        line: entry.line,
        severity: "warn",
        message: `line is ${entry.raw.length} chars; the proposal rebuilds it from topic frontmatter`,
      });
    }
  }
  for (const topic of topics) {
    if (!seen.has(topic.relativePath)) {
      findings.push({
        kind: "orphan-topic",
        file: topic.relativePath,
        severity: "warn",
        message: "topic is not referenced from MEMORY.md; the proposal restores its pointer",
      });
    }
  }
  const lines = index.split(/\r?\n/).length;
  const bytes = Buffer.byteLength(index, "utf8");
  if (lines > INDEX_LINE_CAP || bytes > INDEX_BYTE_CAP) {
    findings.push({
      kind: "index-cap",
      file: "MEMORY.md",
      severity: "warn",
      message: `index is ${lines} lines and ${bytes} bytes; compacting keeps routing context bounded`,
    });
  }
  return findings;
}

function renderProposedIndex(topics: TopicSummary[]): string {
  const groups = new Map<string, TopicSummary[]>();
  for (const topic of topics) {
    const group = topic.type === "unknown" ? "Uncategorized" : titleize(topic.type);
    const existing = groups.get(group) ?? [];
    existing.push(topic);
    groups.set(group, existing);
  }

  const sections = ["# Memory", ""];
  for (const [group, groupTopics] of [...groups.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    sections.push(`## ${group}`);
    for (const topic of groupTopics.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    )) {
      sections.push(`- [${topic.title}](${topic.relativePath}) — ${topic.description}`);
    }
    sections.push("");
  }
  return `${sections.join("\n").trimEnd()}\n`;
}

function renderReport(report: CompactionReport): string {
  const inRootOutput = isInsideRoot(report.root, report.outputDir);
  const proposalBoundary = inRootOutput
    ? "The proposal is written under a hidden in-root directory that validators and compaction scans skip, so extension writes stay confined while durable memory stays unchanged until a human accepts it."
    : "The proposal is written outside the memory root so review cannot accidentally alter durable memory before a human accepts it.";
  const findingLines =
    report.findings.length === 0
      ? ["- No issues found; the proposal normalizes the index from topic frontmatter."]
      : report.findings.map((finding) => {
          const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file;
          return `- ${finding.severity} ${finding.kind} ${loc}: ${finding.message}`;
        });

  return `# Compaction Report

## Summary
- Memory root: ${report.root}
- Proposal directory: ${report.outputDir}
- Topic files read: ${report.topicFileCount}
- Original index: ${report.originalIndexLineCount} lines, ${report.originalIndexBytes} bytes
- Proposed index: ${report.proposedIndexLineCount} lines, ${report.proposedIndexBytes} bytes

## Why this matters
Compaction protects the small, routable MEMORY.md index that adapters inject or search. ${proposalBoundary}

## Findings
${findingLines.join("\n")}

## Proposed Files
- MEMORY.md

## How to apply
Review this proposal against the existing memory directory. If it preserves the load-bearing pointers, replace the root MEMORY.md with the proposed MEMORY.md in a separate, intentional change.
`;
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function prepareOutputDir(
  root: string,
  outputDir: string,
  force: boolean,
  allowInsideRoot: boolean,
): string {
  const resolvedRoot = resolve(root);
  const resolvedOutput = resolve(outputDir);
  const outputInsideRoot = isInsideRoot(resolvedRoot, resolvedOutput);
  if (allowInsideRoot) {
    if (!outputInsideRoot || resolvedOutput === resolvedRoot) {
      throw new Error("output directory must be inside the memory root");
    }
    const realRoot = realpathSync(resolvedRoot);
    const realAncestor = realpathSync(nearestExistingAncestor(dirname(resolvedOutput)));
    if (!isInsideRoot(realRoot, realAncestor)) {
      throw new Error("output directory parent escapes memory root");
    }
    if (existsSync(resolvedOutput)) {
      const realOutput = realpathSync(resolvedOutput);
      if (!isInsideRoot(realRoot, realOutput)) {
        throw new Error("output directory escapes memory root");
      }
    }
  } else if (outputInsideRoot) {
    throw new Error("output directory must be outside the memory root");
  }
  if (existsSync(resolvedOutput)) {
    if (!force) {
      throw new Error(`output directory already exists: ${resolvedOutput}`);
    }
    rmSync(resolvedOutput, { force: true, recursive: true });
  }
  mkdirSync(resolvedOutput, { recursive: true });
  return resolvedOutput;
}

export function compactMemoryDirectory(
  root: string,
  options: CompactMemoryDirectoryOptions = {},
): CompactionReport {
  if (!existsSync(root)) {
    throw new Error(`memory_root does not exist: ${root}`);
  }
  const stats = statSync(root);
  if (!stats.isDirectory()) {
    throw new Error(`memory_root is not a directory: ${root}`);
  }

  const resolvedRoot = resolve(root);
  const outputDir = prepareOutputDir(
    resolvedRoot,
    options.outputDir ?? defaultOutputDir(resolvedRoot),
    options.force ?? false,
    options.allowInsideRoot ?? false,
  );
  const index = readIndex(resolvedRoot);
  const validatorReport = validateMemoryDirectory(resolvedRoot);
  const topicFindings: CompactionFinding[] = [];
  const topics = collectTopics(resolvedRoot, topicFindings);
  const findings = [
    ...collectIndexFindings(
      index,
      topics,
      validatorReport.findings,
    ),
    ...topicFindings,
  ];
  const proposedIndex = renderProposedIndex(topics);
  const proposedIndexPath = join(outputDir, "MEMORY.md");
  const reportPath = join(outputDir, "COMPACTION_REPORT.md");
  const report: CompactionReport = {
    root: resolvedRoot,
    outputDir,
    topicFileCount: topics.length,
    originalIndexLineCount: index.split(/\r?\n/).length,
    proposedIndexLineCount: proposedIndex.split(/\r?\n/).length,
    originalIndexBytes: Buffer.byteLength(index, "utf8"),
    proposedIndexBytes: Buffer.byteLength(proposedIndex, "utf8"),
    findings,
    writtenFiles: [proposedIndexPath, reportPath],
  };

  writeFileSync(proposedIndexPath, proposedIndex);
  writeFileSync(reportPath, renderReport(report));
  return report;
}

function printReport(report: CompactionReport): void {
  console.log("");
  console.log(`memory-substrate compactor — ${report.root}`);
  console.log(`proposal: ${report.outputDir}`);
  console.log(
    `${report.topicFileCount} topic files | ${report.findings.length} findings | proposed ${report.proposedIndexLineCount} index lines`,
  );
  console.log("");
  for (const file of report.writtenFiles) {
    console.log(`wrote ${file}`);
  }
}

function main(): void {
  const root = process.argv[2];
  const outputDir = process.argv[3];
  if (!root) {
    console.error("usage: bun reference/compactor.ts <memory_root> [output_dir]");
    process.exit(2);
  }
  try {
    const report = compactMemoryDirectory(root, { outputDir });
    printReport(report);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (import.meta.main) main();
