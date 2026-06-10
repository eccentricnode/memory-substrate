#!/usr/bin/env bun
// memory-substrate migrator — reference implementation
// Usage: bun reference/migrator.ts <pai_root> <output_dir>
// Spec: SPEC.md v0.1.0-draft §7

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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  validateMemoryDirectory,
  type Finding as ValidatorFinding,
} from "./validator.ts";
import { normalizeMarkdownTarget } from "./markdown-links.ts";

const VALID_TYPES = ["user", "feedback", "project", "reference"] as const;
type MemoryType = typeof VALID_TYPES[number];

const DESCRIPTION_CAP = 200;
const HOOK_CAP = 150;
const INPUT_CONTRACT = "specs/10-pai-migrator-input-schema.md";

export type MigrationFindingKind =
  | "source-validation-finding"
  | "output-validation-finding"
  | "frontmatter-normalized"
  | "frontmatter-inferred"
  | "body-link-rewritten"
  | "invalid-type"
  | "duplicate-topic-name"
  | "index-non-pointer-line"
  | "index-broken-pointer"
  | "index-duplicate-pointer"
  | "index-long-line"
  | "path-conflict"
  | "path-skipped";

export interface MigrationFinding {
  kind: MigrationFindingKind;
  file: string;
  line?: number;
  severity: "info" | "warn" | "error";
  message: string;
}

export interface MigrationReport {
  inputContract: string;
  sourceRoot: string;
  outputDir: string;
  outputMemoryRoot: string;
  sourceTopicFileCount: number;
  migratedTopicFileCount: number;
  skippedFileCount: number;
  sourceIndexLineCount: number;
  proposedIndexLineCount: number;
  findings: MigrationFinding[];
  writtenFiles: string[];
}

export interface MigratePaiMemoryOptions {
  force?: boolean;
}

interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  name?: string;
  description?: string;
  type?: string;
  body: string;
  usedFlatType: boolean;
}

interface MigratedTopic {
  sourceRelativePath: string;
  outputRelativePath: string;
  name: string;
  title: string;
  description: string;
  type: MemoryType;
  body: string;
  hadFrontmatter: boolean;
  usedFlatType: boolean;
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

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function toPortablePath(path: string): string {
  return path.split(sep).join("/");
}

function isExternalLink(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target);
}

function toMarkdownTarget(path: string): string {
  return /\s/.test(path) ? `<${path}>` : path;
}

// Topic files are renamed during migration (type prefix + slugified frontmatter
// name). Intra-memory markdown links in topic bodies still point at the old
// filenames, so re-point any link whose target was renamed. Without this the
// proposed memory root fails validation (SPEC.md §7 / specs/10) with broken-link
// errors and the CLI exits nonzero on real PAI memory that cross-links topics.
function rewriteBodyLinks(
  sourceRoot: string,
  topic: MigratedTopic,
  renameBySourceRel: Map<string, string>,
  findings: MigrationFinding[],
): void {
  const sourceDir = dirname(topic.sourceRelativePath);
  let rewrites = 0;
  const rewritten = topic.body.replace(
    /(!?\[[^\]\n]*\]\()([^)\n]+)(\))/g,
    (whole: string, pre: string, rawTarget: string, post: string) => {
      const target = normalizeMarkdownTarget(rawTarget);
      if (isExternalLink(target)) return whole;
      const hashIndex = target.indexOf("#");
      const pathOnly = hashIndex === -1 ? target : target.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
      if (pathOnly.trim() === "" || isAbsolute(pathOnly)) return whole;
      const targetRel = toPortablePath(
        relative(sourceRoot, resolve(sourceRoot, sourceDir, pathOnly)),
      );
      const renamed = renameBySourceRel.get(targetRel);
      if (!renamed || renamed === targetRel) return whole;
      rewrites += 1;
      return `${pre}${toMarkdownTarget(`${renamed}${fragment}`)}${post}`;
    },
  );
  if (rewrites > 0) {
    topic.body = rewritten;
    findings.push({
      kind: "body-link-rewritten",
      file: topic.sourceRelativePath,
      severity: "info",
      message: `re-pointed ${rewrites} intra-memory link${rewrites === 1 ? "" : "s"} to renamed topic files`,
    });
  }
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function stripTypePrefix(stem: string): string {
  const type = VALID_TYPES.find((candidate) => stem.startsWith(`${candidate}_`));
  return type ? stem.slice(type.length + 1) : stem;
}

function titleize(value: string): string {
  return value
    .replace(/\.md$/i, "")
    .replace(/^(user|feedback|project|reference)_/, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function oneLine(value: string, cap: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length <= cap) return line;
  return line.slice(0, cap - 1).trimEnd();
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith("---\n")) {
    return {
      hasFrontmatter: false,
      body: content,
      usedFlatType: false,
    };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return {
      hasFrontmatter: false,
      body: content,
      usedFlatType: false,
    };
  }
  const frontmatter = content.slice(4, end);
  const body = content.slice(end + "\n---\n".length);
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1];
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1];
  const nestedType = frontmatter.match(/^\s+type:\s*(.+)$/m)?.[1];
  const flatType = frontmatter.match(/^type:\s*(.+)$/m)?.[1];
  return {
    hasFrontmatter: true,
    name: name ? unquote(name) : undefined,
    description: description ? unquote(description) : undefined,
    type: nestedType ? unquote(nestedType) : flatType ? unquote(flatType) : undefined,
    body,
    usedFlatType: Boolean(flatType && !nestedType),
  };
}

function inferType(relativePath: string): MemoryType {
  const stem = basename(relativePath, ".md").toLowerCase();
  if (stem.startsWith("feedback_") || stem.includes("feedback")) return "feedback";
  if (stem.startsWith("project_") || stem.includes("project")) return "project";
  if (stem.startsWith("reference_") || stem.includes("reference")) return "reference";
  if (
    stem.startsWith("user_") ||
    stem.includes("identity") ||
    stem.includes("principal") ||
    stem.includes("preference") ||
    stem.includes("telos")
  ) {
    return "user";
  }
  return "reference";
}

function inferDescription(relativePath: string, body: string): string {
  const firstUsefulLine = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0 && !line.startsWith("---"));
  const inferred = firstUsefulLine
    ? `Migrated from PAI file ${basename(relativePath)}: ${firstUsefulLine}`
    : `Migrated from PAI file ${basename(relativePath)}`;
  return oneLine(inferred.replace(/[`*_#[\]()<>]/g, ""), DESCRIPTION_CAP);
}

function normalizeType(type: string | undefined): MemoryType | undefined {
  if (!type) return undefined;
  return VALID_TYPES.includes(type as MemoryType) ? (type as MemoryType) : undefined;
}

function listMarkdownFiles(root: string, findings: MigrationFinding[]): string[] {
  const out: string[] = [];
  const realRoot = realpathSync(root);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const path = join(dir, entry);
      let stats;
      let realPath;
      try {
        stats = statSync(path);
        realPath = realpathSync(path);
      } catch (error) {
        findings.push({
          kind: "path-skipped",
          file: toPortablePath(relative(root, path)),
          severity: "warn",
          message: `cannot inspect path: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      if (!isInsideRoot(realRoot, realPath)) {
        findings.push({
          kind: "path-skipped",
          file: toPortablePath(relative(root, path)),
          severity: "error",
          message: "path escapes source root",
        });
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(path);
      } else if (entry.endsWith(".md")) {
        out.push(path);
      }
    }
  }
  return out.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

function parseIndexEntries(index: string): IndexEntry[] {
  return index
    .split(/\r?\n/)
    .flatMap((line, indexLine) => {
      const match = line.match(/^- \[([^\]]+)\]\(([^)]+)\)\s*(?:—|--)?\s*(.*)$/);
      const target = normalizeMarkdownTarget(match?.[2] ?? "");
      if (!target) return [];
      return [{ target, line: indexLine + 1, raw: line }];
    });
}

function collectIndexFindings(
  sourceRoot: string,
  index: string,
  migratedBySourcePath: Map<string, MigratedTopic>,
): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const lines = index.split(/\r?\n/);
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const entry = parseIndexEntries(line)[0];
    if (!entry) {
      findings.push({
        kind: "index-non-pointer-line",
        file: "MEMORY.md",
        line: lineNo,
        severity: "warn",
        message: "line is not a memory pointer; migration leaves it in the report for human review",
      });
      continue;
    }
    const sourceTarget = resolve(sourceRoot, entry.target);
    const sourceRelative = toPortablePath(relative(sourceRoot, sourceTarget));
    if (seen.has(sourceRelative)) {
      findings.push({
        kind: "index-duplicate-pointer",
        file: "MEMORY.md",
        line: lineNo,
        severity: "warn",
        message: `duplicate pointer to ${entry.target}; the proposal keeps one canonical pointer`,
      });
    }
    seen.add(sourceRelative);
    if (!migratedBySourcePath.has(sourceRelative)) {
      findings.push({
        kind: "index-broken-pointer",
        file: "MEMORY.md",
        line: lineNo,
        severity: "warn",
        message: `pointer target ${entry.target} was not migrated`,
      });
    }
    if (line.length > HOOK_CAP) {
      findings.push({
        kind: "index-long-line",
        file: "MEMORY.md",
        line: lineNo,
        severity: "warn",
        message: `line is ${line.length} chars; the proposal rebuilds it from topic frontmatter`,
      });
    }
  }
  return findings;
}

function migrateTopic(
  sourceRoot: string,
  path: string,
  usedNames: Map<string, number>,
  usedOutputPaths: Set<string>,
  findings: MigrationFinding[],
): MigratedTopic | undefined {
  const sourceRelativePath = toPortablePath(relative(sourceRoot, path));
  const content = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(content);
  const stem = stripTypePrefix(basename(path, ".md"));
  const baseName = slugify(parsed.name ?? stem, "memory");
  const normalizedType = normalizeType(parsed.type);
  const type = normalizedType ?? inferType(sourceRelativePath);
  if (parsed.type && !normalizedType) {
    findings.push({
      kind: "invalid-type",
      file: sourceRelativePath,
      severity: "warn",
      message: `frontmatter type "${parsed.type}" is not valid; inferred ${type}`,
    });
  }

  const nameKey = `${type}:${baseName}`;
  const seenCount = usedNames.get(nameKey) ?? 0;
  usedNames.set(nameKey, seenCount + 1);
  const name =
    seenCount === 0 ? baseName : slugify(`${baseName}-${seenCount + 1}`, "memory");
  if (seenCount > 0) {
    findings.push({
      kind: "duplicate-topic-name",
      file: sourceRelativePath,
      severity: "warn",
      message: `duplicate ${type} memory name "${baseName}"; migrated as "${name}"`,
    });
  }

  const description = parsed.description
    ? oneLine(parsed.description.replace(/[`*_#[\]()<>]/g, ""), DESCRIPTION_CAP)
    : inferDescription(sourceRelativePath, parsed.body);
  const outputRelativePath = `${type}_${name}.md`;
  if (usedOutputPaths.has(outputRelativePath)) {
    findings.push({
      kind: "path-conflict",
      file: sourceRelativePath,
      severity: "error",
      message: `output path conflict: ${outputRelativePath}`,
    });
    return undefined;
  }
  usedOutputPaths.add(outputRelativePath);

  if (!parsed.hasFrontmatter) {
    findings.push({
      kind: "frontmatter-inferred",
      file: sourceRelativePath,
      severity: "warn",
      message: `added memory-substrate frontmatter as ${type}/${name}`,
    });
  } else if (parsed.usedFlatType || parsed.name !== name || parsed.type !== type) {
    findings.push({
      kind: "frontmatter-normalized",
      file: sourceRelativePath,
      severity: "info",
      message: `normalized frontmatter as ${type}/${name}`,
    });
  }

  return {
    sourceRelativePath,
    outputRelativePath,
    name,
    title: titleize(name),
    description,
    type,
    body: parsed.body.trimStart(),
    hadFrontmatter: parsed.hasFrontmatter,
    usedFlatType: parsed.usedFlatType,
  };
}

function renderTopic(topic: MigratedTopic): string {
  const body = topic.body.trimEnd();
  return `---
name: ${topic.name}
description: ${topic.description}
metadata:
  type: ${topic.type}
---

${body}
`;
}

function renderIndex(topics: MigratedTopic[]): string {
  const groups = new Map<MemoryType, MigratedTopic[]>();
  for (const topic of topics) {
    groups.set(topic.type, [...(groups.get(topic.type) ?? []), topic]);
  }
  const sections = ["# Memory", ""];
  for (const type of VALID_TYPES) {
    const groupTopics = groups.get(type);
    if (!groupTopics || groupTopics.length === 0) continue;
    sections.push(`## ${titleize(type)}`);
    for (const topic of groupTopics.sort((a, b) =>
      a.outputRelativePath.localeCompare(b.outputRelativePath),
    )) {
      sections.push(`- [${topic.title}](${topic.outputRelativePath}) — ${oneLine(topic.description, HOOK_CAP)}`);
    }
    sections.push("");
  }
  return `${sections.join("\n").trimEnd()}\n`;
}

function renderReport(report: MigrationReport): string {
  const findingLines =
    report.findings.length === 0
      ? ["- No issues found; the proposal is validator-clean."]
      : report.findings.map((finding) => {
          const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file;
          return `- ${finding.severity} ${finding.kind} ${loc}: ${finding.message}`;
        });

  return `# Migration Report

## Summary
- Source root: ${report.sourceRoot}
- Proposal directory: ${report.outputDir}
- Proposed memory root: ${report.outputMemoryRoot}
- Source topic files read: ${report.sourceTopicFileCount}
- Migrated topic files: ${report.migratedTopicFileCount}
- Skipped files: ${report.skippedFileCount}
- Source index lines: ${report.sourceIndexLineCount}
- Proposed index lines: ${report.proposedIndexLineCount}

## Why this matters
Migration is a one-way proposal from the historical PAI shape into the memory-substrate contract. The source directory is left untouched, and the generated memory root is validated so a human can review concrete files instead of trusting an in-place rewrite.

## Input Contract
- Contract: ${report.inputContract}
- Accepted source topics: nested memory-substrate frontmatter, historical flat \`type:\` frontmatter, or imported markdown with inferred frontmatter.
- Index handling: source \`MEMORY.md\` is review context; the proposed index is rebuilt from migrated topics so duplicate, broken, long, or non-pointer source lines cannot leak into durable output.

## Findings
${findingLines.join("\n")}

## Proposed Files
${report.writtenFiles.map((file) => `- ${file}`).join("\n")}

## How to apply
Review the proposed memory directory and this report. After confirming the inferred or normalized entries preserve the load-bearing memories, copy the proposed memory root into the desired adapter memory location in a separate intentional step.
`;
}

function prepareOutputDir(sourceRoot: string, outputDir: string, force: boolean): string {
  const resolvedSourceRoot = resolve(sourceRoot);
  const resolvedOutput = resolve(outputDir);
  const realSourceRoot = realpathSync(resolvedSourceRoot);
  const realAncestor = realpathSync(nearestExistingAncestor(dirname(resolvedOutput)));
  if (
    resolvedSourceRoot === resolvedOutput ||
    isInsideRoot(resolvedSourceRoot, resolvedOutput) ||
    isInsideRoot(realSourceRoot, realAncestor)
  ) {
    throw new Error("output directory must be outside the PAI source root");
  }
  if (existsSync(resolvedOutput)) {
    const realOutput = realpathSync(resolvedOutput);
    if (isInsideRoot(realSourceRoot, realOutput)) {
      throw new Error("output directory must be outside the PAI source root");
    }
    if (!force) {
      throw new Error(`output directory already exists: ${resolvedOutput}`);
    }
    rmSync(resolvedOutput, { force: true, recursive: true });
  }
  mkdirSync(resolvedOutput, { recursive: true });
  const realOutput = realpathSync(resolvedOutput);
  if (isInsideRoot(realSourceRoot, realOutput)) {
    rmSync(resolvedOutput, { force: true, recursive: true });
    throw new Error("output directory must be outside the PAI source root");
  }
  return resolvedOutput;
}

function validatorFindings(
  kind: "source-validation-finding" | "output-validation-finding",
  findings: ValidatorFinding[],
): MigrationFinding[] {
  return findings.map((finding) => ({
    kind,
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    message: finding.msg,
  }));
}

export function migratePaiMemoryDirectory(
  paiRoot: string,
  outputDir: string,
  options: MigratePaiMemoryOptions = {},
): MigrationReport {
  if (!existsSync(paiRoot)) {
    throw new Error(`pai_root does not exist: ${paiRoot}`);
  }
  const stats = statSync(paiRoot);
  if (!stats.isDirectory()) {
    throw new Error(`pai_root is not a directory: ${paiRoot}`);
  }

  const sourceRoot = resolve(paiRoot);
  const resolvedOutputDir = prepareOutputDir(
    sourceRoot,
    outputDir,
    options.force ?? false,
  );
  const outputMemoryRoot = join(resolvedOutputDir, "memory");
  mkdirSync(outputMemoryRoot, { recursive: true });

  const sourceValidation = validateMemoryDirectory(sourceRoot);
  const findings: MigrationFinding[] = [
    ...validatorFindings("source-validation-finding", sourceValidation.findings),
  ];
  const sourceIndexPath = join(sourceRoot, "MEMORY.md");
  const sourceIndex = existsSync(sourceIndexPath)
    ? readFileSync(sourceIndexPath, "utf8")
    : "";
  const markdownFiles = listMarkdownFiles(sourceRoot, findings);
  const topicFiles = markdownFiles.filter((path) => basename(path) !== "MEMORY.md");
  const usedNames = new Map<string, number>();
  const usedOutputPaths = new Set<string>();
  const topics = topicFiles.flatMap((path) => {
    const topic = migrateTopic(sourceRoot, path, usedNames, usedOutputPaths, findings);
    return topic ? [topic] : [];
  });
  const migratedBySourcePath = new Map(
    topics.map((topic) => [topic.sourceRelativePath, topic]),
  );
  const renameBySourceRel = new Map(
    topics.map((topic) => [topic.sourceRelativePath, topic.outputRelativePath]),
  );
  for (const topic of topics) {
    rewriteBodyLinks(sourceRoot, topic, renameBySourceRel, findings);
  }
  findings.push(...collectIndexFindings(sourceRoot, sourceIndex, migratedBySourcePath));

  const writtenFiles: string[] = [];
  for (const topic of topics) {
    const outputPath = join(outputMemoryRoot, topic.outputRelativePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, renderTopic(topic));
    writtenFiles.push(outputPath);
  }
  const proposedIndex = renderIndex(topics);
  const proposedIndexPath = join(outputMemoryRoot, "MEMORY.md");
  writeFileSync(proposedIndexPath, proposedIndex);
  writtenFiles.push(proposedIndexPath);

  const outputValidation = validateMemoryDirectory(outputMemoryRoot);
  findings.push(
    ...validatorFindings("output-validation-finding", outputValidation.findings),
  );

  const reportPath = join(resolvedOutputDir, "MIGRATION_REPORT.md");
  const report: MigrationReport = {
    inputContract: INPUT_CONTRACT,
    sourceRoot,
    outputDir: resolvedOutputDir,
    outputMemoryRoot,
    sourceTopicFileCount: topicFiles.length,
    migratedTopicFileCount: topics.length,
    skippedFileCount: topicFiles.length - topics.length,
    sourceIndexLineCount: sourceIndex ? sourceIndex.split(/\r?\n/).length : 0,
    proposedIndexLineCount: proposedIndex.split(/\r?\n/).length,
    findings,
    writtenFiles: [...writtenFiles, reportPath],
  };
  writeFileSync(reportPath, renderReport(report));
  return report;
}

function printReport(report: MigrationReport): void {
  console.log("");
  console.log(`memory-substrate migrator — ${report.sourceRoot}`);
  console.log(`proposal: ${report.outputMemoryRoot}`);
  console.log(
    `${report.migratedTopicFileCount}/${report.sourceTopicFileCount} topic files migrated | ${report.findings.length} findings | proposed ${report.proposedIndexLineCount} index lines`,
  );
  console.log("");
  for (const file of report.writtenFiles) {
    console.log(`wrote ${file}`);
  }
}

function main(): void {
  const paiRoot = process.argv[2];
  const outputDir = process.argv[3];
  if (!paiRoot || !outputDir) {
    console.error("usage: bun reference/migrator.ts <pai_root> <output_dir>");
    process.exit(2);
  }
  try {
    const report = migratePaiMemoryDirectory(paiRoot, outputDir);
    printReport(report);
    const hasOutputErrors = report.findings.some(
      (finding) =>
        finding.kind === "output-validation-finding" &&
        finding.severity === "error",
    );
    process.exit(hasOutputErrors ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (import.meta.main) main();
