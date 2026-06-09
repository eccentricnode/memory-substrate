import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveRuntimeConfig, type RuntimeEnv } from "./config.ts";
import { RECURSION_GUARD_ENV } from "./worker.ts";

export interface MemoryResearchRequest {
  question: string;
  cwd: string;
  env?: RuntimeEnv;
  homeDir?: string;
}

export interface MemoryResearchResult {
  status: "found" | "not-found" | "disabled" | "ignored" | "unavailable" | "failed";
  found: boolean;
  answer: string;
  citations: string[];
  memoryRoot?: string;
  error?: string;
  outputTail?: string;
}

export interface MemoryResearchProcessOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface MemoryResearchProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export type MemoryResearchProcessExecutor = (
  command: string,
  args: string[],
  options: MemoryResearchProcessOptions,
) => Promise<MemoryResearchProcessResult>;

export interface MemoryResearchOptions {
  command?: string;
  timeoutMs?: number;
  process?: MemoryResearchProcessExecutor;
}

const RESEARCH_TIMEOUT_MS = 120_000;
const RESEARCH_REACHABILITY_PROMPT =
  "Memory research model reachability check. Reply exactly: OK";

function childEnv(requestEnv: RuntimeEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(requestEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function outputTail(stdout = "", stderr = "", maxChars = 800): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (combined.length <= maxChars) return combined;
  return combined.slice(combined.length - maxChars);
}

function defaultResearchProcessExecutor(
  command: string,
  args: string[],
  options: MemoryResearchProcessOptions,
): Promise<MemoryResearchProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    const finish = (result: MemoryResearchProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProcess(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ code: 2, stdout, stderr: error.message, killed: timedOut });
    });
    child.on("close", (code, signal) => {
      const timeoutMessage = timedOut
        ? `memory research timed out after ${options.timeoutMs}ms`
        : "";
      finish({
        code: code ?? 1,
        stdout,
        stderr: [stderr.trim(), timeoutMessage].filter(Boolean).join("\n"),
        killed: timedOut || signal !== null,
      });
    });
  });
}

function researchProcessArgs(model: string, prompt: string): string[] {
  return [
    "--print",
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-session",
    "--tools",
    "read,grep,find,ls",
    "--model",
    model,
    prompt,
  ];
}

async function preflightReachability(
  command: string,
  model: string,
  execProcess: MemoryResearchProcessExecutor,
  options: MemoryResearchProcessOptions,
): Promise<MemoryResearchResult | undefined> {
  const result = await execProcess(
    command,
    researchProcessArgs(model, RESEARCH_REACHABILITY_PROMPT),
    options,
  );
  if (result.code === 0) return undefined;
  return {
    status: "failed",
    found: false,
    answer: "memory research failed before searching memory",
    citations: [],
    error:
      result.stderr ||
      `memory research model reachability preflight failed: ${model}`,
    outputTail: outputTail(result.stdout, result.stderr),
  };
}

function researchPrompt(memoryRoot: string, question: string): string {
  return `You are the memory-substrate read-only research sub-agent.

Answer the memory question by searching and reading only this memory root:
${memoryRoot}

Use MEMORY.md as the index. Follow relative markdown links to relevant topic files.
Use read, grep, find, or ls only. Do not write, edit, delete, move, or create files.
Do not inspect files outside the memory root. If there is no matching memory, say so.

Return exactly one JSON object with no markdown fences or commentary:
{"found":true,"answer":"short synthesis","citations":["relative-topic.md"]}

Question:
${question}
`;
}

function parseResearchPayload(stdout: string): {
  found: boolean;
  answer: string;
  citations: string[];
} {
  const payload = JSON.parse(stdout.trim()) as unknown;
  if (!payload || typeof payload !== "object") {
    throw new Error("memory research JSON must be an object");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.found !== "boolean") {
    throw new Error("memory research JSON missing boolean found");
  }
  if (typeof record.answer !== "string" || record.answer.trim() === "") {
    throw new Error("memory research JSON missing answer");
  }
  if (
    !Array.isArray(record.citations) ||
    !record.citations.every((item) => typeof item === "string")
  ) {
    throw new Error("memory research JSON missing citations array");
  }
  return {
    found: record.found,
    answer: record.answer.trim(),
    citations: record.citations.map((item) => item.trim()).filter(Boolean),
  };
}

function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
  );
}

function indexedTopicPaths(memoryRoot: string): Set<string> {
  const index = readFileSync(resolve(memoryRoot, "MEMORY.md"), "utf8");
  const paths = new Set<string>();
  for (const line of index.split(/\r?\n/)) {
    const match = line.match(/^- \[[^\]]+\]\(([^)]+\.md)\)/);
    const target = match?.[1]?.trim();
    if (target && target !== "MEMORY.md") paths.add(target);
  }
  return paths;
}

function validateResearchCitations(memoryRoot: string, citations: string[]): string[] {
  const indexed = indexedTopicPaths(memoryRoot);
  const realRoot = realpathSync(memoryRoot);
  const valid: string[] = [];
  for (const citation of citations) {
    if (
      citation === "" ||
      citation.includes("\0") ||
      citation.includes("\n") ||
      citation.includes("\r") ||
      isAbsolute(citation) ||
      citation === "MEMORY.md" ||
      !citation.endsWith(".md") ||
      !indexed.has(citation)
    ) {
      throw new Error(`invalid memory research citation: ${citation}`);
    }
    const target = resolve(memoryRoot, citation);
    if (!isInsideRoot(memoryRoot, target) || !existsSync(target)) {
      throw new Error(`invalid memory research citation: ${citation}`);
    }
    const realTarget = realpathSync(target);
    const rel = relative(realRoot, realTarget);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || !statSync(realTarget).isFile()) {
      throw new Error(`invalid memory research citation: ${citation}`);
    }
    valid.push(citation);
  }
  return valid;
}

export async function researchMemory(
  request: MemoryResearchRequest,
  options: MemoryResearchOptions = {},
): Promise<MemoryResearchResult> {
  const question = request.question.trim();
  if (!question) {
    return {
      status: "failed",
      found: false,
      answer: "memory research requires a question",
      citations: [],
      error: "missing question",
    };
  }

  const config = resolveRuntimeConfig({
    cwd: request.cwd,
    env: request.env,
    homeDir: request.homeDir,
  });
  if (!config.enabled) {
    return {
      status: "disabled",
      found: false,
      answer: "memory research skipped: disabled",
      citations: [],
    };
  }
  if (config.ignore) {
    return {
      status: "ignored",
      found: false,
      answer: "memory research skipped: ignored",
      citations: [],
    };
  }
  if (config.error?.includes("model must be provider-qualified")) {
    return {
      status: "failed",
      found: false,
      answer: "memory research failed before searching memory",
      citations: [],
      error: config.error.replace("memory worker model", "memory research model"),
    };
  }
  if (!config.memoryRoot || config.error) {
    return {
      status: "unavailable",
      found: false,
      answer: "memory research unavailable",
      citations: [],
      error: config.error ?? "memory root unavailable",
    };
  }

  const model = config.researchModel;

  const command = options.command ?? "pi";
  const timeoutMs = options.timeoutMs ?? RESEARCH_TIMEOUT_MS;
  const execProcess = options.process ?? defaultResearchProcessExecutor;
  const processOptions: MemoryResearchProcessOptions = {
    cwd: config.memoryRoot,
    env: childEnv({
      ...(request.env ?? {}),
      ...RECURSION_GUARD_ENV,
      PI_MEMORY_ROOT: config.memoryRoot,
      PI_MEMORY_MODEL: model,
    }),
    timeoutMs,
  };

  const preflight = await preflightReachability(
    command,
    model,
    execProcess,
    processOptions,
  );
  if (preflight) return { ...preflight, memoryRoot: config.memoryRoot };

  const result = await execProcess(
    command,
    researchProcessArgs(model, researchPrompt(config.memoryRoot, question)),
    processOptions,
  );
  if (result.code !== 0) {
    return {
      status: "failed",
      found: false,
      answer: "memory research failed",
      citations: [],
      memoryRoot: config.memoryRoot,
      error: result.stderr || `memory research exited with ${result.code}`,
      outputTail: outputTail(result.stdout, result.stderr),
    };
  }

  try {
    const parsed = parseResearchPayload(result.stdout);
    const citations = validateResearchCitations(config.memoryRoot, parsed.citations);
    if (parsed.found && citations.length === 0) {
      throw new Error("memory research found result missing valid citations");
    }
    return {
      status: parsed.found ? "found" : "not-found",
      found: parsed.found,
      answer: parsed.answer,
      citations,
      memoryRoot: config.memoryRoot,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      found: false,
      answer: "memory research failed to parse its result",
      citations: [],
      memoryRoot: config.memoryRoot,
      error: detail,
      outputTail: outputTail(result.stdout, result.stderr),
    };
  }
}
