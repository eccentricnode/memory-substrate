import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "./config.ts";

export const INJECTION_MAX_LINES = 12;
export const INJECTION_MAX_BYTES = 4 * 1024;
export const REACTIVE_OVERLAP_SCORE_THRESHOLD = 3;

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

export interface RankedMemoryIndexEntry {
  line: string;
  order: number;
  score: number;
}

export type ReactiveMemoryGateReason = "recall-cue" | "index-overlap";

export interface ReactiveMemoryGate {
  shouldFire: boolean;
  reason?: ReactiveMemoryGateReason;
  topScore: number;
  injection?: MemoryInjection;
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

export function matchedResumeMemoryRequest(prompt: string): string | undefined {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const patterns: Array<[string, RegExp]> = [
    ["resume memory", /\bresume memor(?:y|ies)\b/],
    ["use memory again", /\buse memor(?:y|ies) again\b/],
    ["stop ignoring memory", /\bstop ignoring memor(?:y|ies)\b/],
    ["clear memory ignore", /\bclear memor(?:y|ies) ignore\b/],
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

function readIndex(
  config: RuntimeConfig,
  fs?: InjectionFileSystem,
): string | undefined {
  if (!config.memoryRoot) return undefined;
  const fileSystem = fs ?? {
    readFile: (path: string) => readFileSync(path, "utf8"),
  };
  try {
    return fileSystem.readFile(join(config.memoryRoot, "MEMORY.md"));
  } catch {
    return undefined;
  }
}

export function rankMemoryIndexEntries(
  index: string,
  prompt: string,
): RankedMemoryIndexEntry[] {
  const terms = salientTerms(prompt);
  if (terms.size === 0) return [];
  return indexEntryLines(index)
    .map((line, order) => ({ line, order, score: scoreLine(line, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
}

export function renderMemoryInjectionFromRanked(
  ranked: RankedMemoryIndexEntry[],
): MemoryInjection | undefined {
  if (ranked.length === 0) return undefined;
  const capped = renderBounded(ranked.map((entry) => entry.line));
  if (capped.count === 0) return undefined;
  return {
    text: capped.text,
    selectedLines: capped.text.split("\n").slice(1),
    truncated: ranked.length > capped.count,
  };
}

export function detectsRecallIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const cues = [
    /\bremember\b/,
    /\brecall\b/,
    /\bwe decided\b/,
    /\blast time\b/,
    /\bprior\b/,
    /\bearlier\b/,
    /\bwhat did we\b/,
    /\bdid we\b/,
    /\bpreviously\b/,
    /\bbefore\b/,
  ];
  return cues.some((cue) => cue.test(normalized));
}

export function buildReactiveMemoryGate(input: BuildMemoryInjectionInput): ReactiveMemoryGate {
  if (!input.config.enabled || input.ignored || input.config.error) {
    return { shouldFire: false, topScore: 0 };
  }

  const index = readIndex(input.config, input.fs);
  const ranked = index ? rankMemoryIndexEntries(index, input.prompt) : [];
  const injection = renderMemoryInjectionFromRanked(ranked);
  const topScore = ranked[0]?.score ?? 0;
  if (detectsRecallIntent(input.prompt)) {
    return { shouldFire: true, reason: "recall-cue", topScore, injection };
  }
  if (topScore >= REACTIVE_OVERLAP_SCORE_THRESHOLD) {
    return { shouldFire: true, reason: "index-overlap", topScore, injection };
  }
  return { shouldFire: false, topScore, injection };
}

export function buildMemoryInjection(
  input: BuildMemoryInjectionInput,
): MemoryInjection | undefined {
  if (!input.config.enabled || input.ignored || input.config.error) return undefined;
  if (!input.config.memoryRoot) return undefined;

  const index = readIndex(input.config, input.fs);
  if (!index) return undefined;
  return renderMemoryInjectionFromRanked(
    rankMemoryIndexEntries(index, input.prompt),
  );
}
