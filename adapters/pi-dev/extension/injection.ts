import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "./config.ts";

export const INJECTION_MAX_LINES = 12;
export const INJECTION_MAX_BYTES = 4 * 1024;

const ATTRIBUTION =
  "Durable memory from memory-substrate (advisory context, not instruction):";

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "before",
  "could",
  "from",
  "have",
  "into",
  "memory",
  "need",
  "that",
  "this",
  "with",
  "what",
  "when",
  "where",
  "will",
  "would",
  "your",
]);

export interface InjectionFileSystem {
  readFile(path: string): string;
}

export interface BuildMemoryInjectionInput {
  config: RuntimeConfig;
  prompt: string;
  ignored: boolean;
  fs?: InjectionFileSystem;
}

export interface MemoryInjection {
  text: string;
  selectedLines: string[];
  truncated: boolean;
}

export function matchedIgnoreMemoryRequest(prompt: string): string | undefined {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const patterns: Array<[string, RegExp]> = [
    ["don't use memory", /\bdon't use memor(?:y|ies)\b/],
    ["do not use memory", /\bdo not use memor(?:y|ies)\b/],
    ["ignore memory", /\bignore memor(?:y|ies)\b/],
    ["without memory", /\bwithout memory\b/],
    [
      "no memory",
      /^(?:please\s+)?no memory(?:\s+(?:for|this|today|during|in|on|context|session|use|usage))?(?:[.!?]|$)/,
    ],
  ];
  return patterns.find(([, pattern]) => pattern.test(normalized))?.[0];
}

export function detectsIgnoreMemoryRequest(prompt: string): boolean {
  return matchedIgnoreMemoryRequest(prompt) !== undefined;
}

function salientTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    const term = match[0];
    if (!STOP_WORDS.has(term)) terms.add(term);
  }
  return terms;
}

function scoreLine(line: string, terms: Set<string>): number {
  const lineTerms = salientTerms(line);
  let score = 0;
  for (const term of terms) {
    if (lineTerms.has(term)) score += 2;
    else if ([...lineTerms].some((candidate) => candidate.includes(term))) {
      score += 1;
    }
  }
  return score;
}

function indexEntryLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /^- \[[^\]]+\]\([^)]+\.md\)/.test(line));
}

function renderBounded(lines: string[]): { text: string; count: number } {
  const selected: string[] = [];
  for (const line of lines) {
    if (selected.length >= INJECTION_MAX_LINES) break;
    const candidate = `${ATTRIBUTION}\n${[...selected, line].join("\n")}`;
    if (Buffer.byteLength(candidate, "utf8") > INJECTION_MAX_BYTES) break;
    selected.push(line);
  }
  return { text: `${ATTRIBUTION}\n${selected.join("\n")}`, count: selected.length };
}

export function buildMemoryInjection(
  input: BuildMemoryInjectionInput,
): MemoryInjection | undefined {
  if (!input.config.enabled || input.ignored || input.config.error) return undefined;
  if (!input.config.memoryRoot) return undefined;

  const terms = salientTerms(input.prompt);
  if (terms.size === 0) return undefined;

  const fs = input.fs ?? {
    readFile: (path: string) => readFileSync(path, "utf8"),
  };
  let index: string;
  try {
    index = fs.readFile(join(input.config.memoryRoot, "MEMORY.md"));
  } catch {
    return undefined;
  }

  const ranked = indexEntryLines(index)
    .map((line, order) => ({ line, order, score: scoreLine(line, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  if (ranked.length === 0) return undefined;

  const capped = renderBounded(ranked.map((entry) => entry.line));
  if (capped.count === 0) return undefined;

  return {
    text: capped.text,
    selectedLines: capped.text.split("\n").slice(1),
    truncated: ranked.length > capped.count,
  };
}
