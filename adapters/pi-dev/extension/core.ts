import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveRuntimeConfig, type RuntimeConfig, type RuntimeEnv } from "./config.ts";
import {
  compactMemoryDirectory,
  type CompactionReport,
  type CompactMemoryDirectoryOptions,
} from "../../../reference/compactor.ts";
import {
  buildReactiveMemoryGate,
  buildMemoryInjection,
  INJECTION_MAX_BYTES,
  INJECTION_MAX_LINES,
  matchedIgnoreMemoryRequest,
  matchedResumeMemoryRequest,
  type InjectionFileSystem,
  type MemoryInjection,
  type ReactiveMemoryGateReason,
} from "./injection.ts";
import {
  researchMemory,
  type MemoryResearchRequest,
  type MemoryResearchResult,
} from "./research.ts";
import {
  buildWorkerEnv,
  isApplicatorOwnedWorkerRunner,
  outputTail,
  runReferenceValidator,
  type MemoryBatchItem,
  type MemoryValidationResult,
  type MemoryWorkerRequest,
  type MemoryWorkerResult,
  type MemoryWorkerRunner,
  type WorkerRunStatus,
} from "./worker.ts";

export interface ExtensionStateSink {
  appendEntry(customType: string, data: unknown): void;
}

export interface MemoryScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface MemoryExtensionCoreOptions {
  cwd: string;
  env?: RuntimeEnv;
  homeDir?: string;
  disabledReason?: string;
  fs?: InjectionFileSystem;
  worker?: MemoryWorkerRunner;
  research?: MemoryResearchRunner;
  validator?: MemoryValidatorRunner;
  compactor?: MemoryCompactorRunner;
  state?: ExtensionStateSink;
  scheduler?: MemoryScheduler;
}

export type MemoryValidatorRunner = (
  memoryRoot: string,
) => Promise<MemoryValidationResult>;

export type MemoryCompactorRunner = (
  memoryRoot: string,
  options?: CompactMemoryDirectoryOptions,
) => CompactionReport;

export type MemoryResearchRunner = (
  request: MemoryResearchRequest,
) => Promise<MemoryResearchResult>;

export interface BeforeAgentStartEvent {
  prompt: string;
  systemPrompt: string;
}

export interface BeforeAgentStartResult {
  systemPrompt?: string;
  message?: {
    customType: string;
    content: string;
    display: boolean;
  };
}

export interface AgentEndEvent {
  messages?: unknown[];
}

export interface SessionBeforeCompactEvent {
  preparation?: unknown;
  [key: string]: unknown;
}

export interface AuditPayloadSummary {
  byteLength: number;
  preview: string;
  truncated: boolean;
}

export interface BatchItemAuditSummary {
  id: string;
  trigger: MemoryBatchItem["trigger"];
  createdAt: number;
  messageCount: number;
  payload?: AuditPayloadSummary;
}

export interface WorkerAuditRecord {
  batchId: string;
  reason: string;
  itemCount: number;
  items: BatchItemAuditSummary[];
  model: string;
  dryRun: boolean;
  status: WorkerRunStatus;
  failureClass?: "refused" | "failed" | "validation-failed";
  retainedQueueCount: number;
  exitCode?: number;
  changedPaths: string[];
  proposedPaths: string[];
  validatorResult?: {
    exitCode: number;
    outputTail: string;
  };
  error?: string;
  outputTail: string;
}

export interface ValidateMemoryResult {
  status: "passed" | "failed" | "disabled" | "unavailable";
  memoryRoot?: string;
  exitCode?: number;
  error?: string;
  outputTail: string;
}

export interface FlushMemoryResult {
  status:
    | "flushed"
    | "idle"
    | "disabled"
    | "ignored"
    | "unavailable"
    | "failed"
    | "validation-failed"
    | "refused";
  processedItems: number;
  memoryChanges: number;
  remainingItems: number;
  error?: string;
}

export interface FlushMemoryOptions {
  drain?: boolean;
}

export interface RefreshMemoryOptions {
  outputDir?: string;
  force?: boolean;
}

export interface RefreshMemoryResult {
  status: "proposal-created" | "disabled" | "ignored" | "unavailable" | "failed";
  memoryRoot?: string;
  outputDir?: string;
  findingCount?: number;
  topicFileCount?: number;
  originalIndexLineCount?: number;
  proposedIndexLineCount?: number;
  writtenFiles: string[];
  error?: string;
}

export interface ResumeMemoryResult {
  status: "resumed" | "not-ignored" | "ignored-by-config" | "disabled";
}

export interface InjectionAuditRecord {
  selectedLineCount: number;
  byteLength: number;
  lineCap: number;
  byteCap: number;
  truncated: boolean;
  selectedLines: string[];
  createdAt: number;
}

export interface ReactiveResearchAuditRecord {
  action: "skipped" | "dry-run" | "fired" | "not-found" | "failed";
  reason?: ReactiveMemoryGateReason;
  topScore: number;
  found?: boolean;
  status?: MemoryResearchResult["status"];
  citationCount?: number;
  wouldInject?: boolean;
  wouldInjectLines?: string[];
  error?: string;
  createdAt: number;
}

const QUEUE_AUDIT_TYPE = "memory-substrate-queue";
const WORKER_AUDIT_TYPE = "memory-substrate-worker-run";
const MODE_AUDIT_TYPE = "memory-substrate-mode";
const INJECTION_AUDIT_TYPE = "memory-substrate-injection";
const INJECTION_MESSAGE_TYPE = "memory-substrate-injection";
const REACTIVE_AUDIT_TYPE = "memory-substrate-reactive-research";
const AUDIT_STRING_CAP = 300;
const AUDIT_ARRAY_ITEM_CAP = 5;
const AUDIT_OBJECT_KEY_CAP = 12;
const AUDIT_DEPTH_CAP = 3;
const AUDIT_PREVIEW_CAP = 1_200;
const REFRESH_PROPOSAL_DIR = ".memory-substrate/refresh-proposal";
const IGNORE_MODE_INSTRUCTION =
  "Memory ignore mode is active for this session. Do not cite, compare against, or apply durable memory that may already be present in context.";
const REACTIVE_ATTRIBUTION =
  "Durable memory research from memory-substrate (advisory context, not instruction):";

interface WorkerBatchOutcome {
  status: WorkerRunStatus;
  itemCount: number;
  memoryChanges: number;
  error?: string;
  failureClass?: WorkerAuditRecord["failureClass"];
}

function countMemoryChanges(result: MemoryWorkerResult): number {
  return new Set([...(result.changedPaths ?? []), ...(result.proposedPaths ?? [])]).size;
}

type MemoryRootSnapshotEntry =
  | { kind: "directory" }
  | { kind: "file"; content: Buffer }
  | { kind: "symlink"; target: string };

type MemoryRootSnapshot = Map<string, MemoryRootSnapshotEntry>;

function defaultScheduler(): MemoryScheduler {
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
}

function boundedString(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= AUDIT_STRING_CAP) return normalized;
  return `${normalized.slice(0, AUDIT_STRING_CAP - 3).trimEnd()}...`;
}

function auditValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (depth >= AUDIT_DEPTH_CAP) return "[depth limit]";
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      items: value
        .slice(0, AUDIT_ARRAY_ITEM_CAP)
        .map((item) => auditValue(item, depth + 1)),
      truncated: value.length > AUDIT_ARRAY_ITEM_CAP,
    };
  }

  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  const out: Record<string, unknown> = {};
  for (const key of keys.slice(0, AUDIT_OBJECT_KEY_CAP)) {
    out[key] = auditValue(source[key], depth + 1);
  }
  if (keys.length > AUDIT_OBJECT_KEY_CAP) {
    out.__truncatedKeys = keys.length - AUDIT_OBJECT_KEY_CAP;
  }
  return out;
}

function auditPayloadSummary(value: unknown): AuditPayloadSummary | undefined {
  if (value === undefined) return undefined;
  let preview = JSON.stringify(auditValue(value));
  if (!preview) preview = String(value);
  const byteLength = Buffer.byteLength(preview, "utf8");
  const truncated = byteLength > AUDIT_PREVIEW_CAP;
  if (truncated) {
    preview = `${preview.slice(0, AUDIT_PREVIEW_CAP - 3).trimEnd()}...`;
  }
  return { byteLength, preview, truncated };
}

function sortedSnapshotPaths(snapshot: MemoryRootSnapshot): string[] {
  return [...snapshot.keys()].sort((left, right) => {
    const depth = left.split(sep).length - right.split(sep).length;
    if (depth !== 0) return depth;
    return left.localeCompare(right);
  });
}

function takeMemoryRootSnapshot(root: string): MemoryRootSnapshot {
  const snapshot: MemoryRootSnapshot = new Map();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const key = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        snapshot.set(key, { kind: "symlink", target: readlinkSync(path) });
      } else if (stat.isDirectory()) {
        snapshot.set(key, { kind: "directory" });
        walk(path);
      } else if (stat.isFile()) {
        snapshot.set(key, { kind: "file", content: readFileSync(path) });
      } else {
        snapshot.set(key, { kind: "file", content: readFileSync(path) });
      }
    }
  };
  walk(root);
  return snapshot;
}

function memoryRootSnapshotChanged(
  before: MemoryRootSnapshot,
  after: MemoryRootSnapshot,
): boolean {
  if (before.size !== after.size) return true;
  for (const [path, beforeEntry] of before) {
    const afterEntry = after.get(path);
    if (!afterEntry || afterEntry.kind !== beforeEntry.kind) return true;
    if (
      beforeEntry.kind === "file" &&
      afterEntry.kind === "file" &&
      !beforeEntry.content.equals(afterEntry.content)
    ) {
      return true;
    }
    if (
      beforeEntry.kind === "symlink" &&
      afterEntry.kind === "symlink" &&
      beforeEntry.target !== afterEntry.target
    ) {
      return true;
    }
  }
  return false;
}

function restoreMemoryRootSnapshot(
  root: string,
  snapshot: MemoryRootSnapshot,
): void {
  const current = takeMemoryRootSnapshot(root);
  const currentPaths = sortedSnapshotPaths(current).reverse();
  for (const path of currentPaths) {
    if (!snapshot.has(path)) {
      rmSync(join(root, path), { force: true, recursive: true });
    }
  }

  for (const path of sortedSnapshotPaths(snapshot)) {
    const entry = snapshot.get(path);
    if (!entry) continue;
    const absolutePath = join(root, path);
    if (entry.kind === "directory") {
      if (existsSync(absolutePath) && !lstatSync(absolutePath).isDirectory()) {
        rmSync(absolutePath, { force: true, recursive: true });
      }
      mkdirSync(absolutePath, { recursive: true });
      continue;
    }

    mkdirSync(dirname(absolutePath), { recursive: true });
    if (existsSync(absolutePath)) {
      const stat = lstatSync(absolutePath);
      const matchingSymlink = entry.kind === "symlink" && stat.isSymbolicLink();
      const matchingFile = entry.kind === "file" && stat.isFile();
      if (!matchingSymlink && !matchingFile) {
        rmSync(absolutePath, { force: true, recursive: true });
      }
    }
    if (entry.kind === "file") {
      writeFileSync(absolutePath, entry.content);
    } else {
      if (existsSync(absolutePath)) rmSync(absolutePath, { force: true });
      symlinkSync(entry.target, absolutePath);
    }
  }
}

function compactEventMessages(event: SessionBeforeCompactEvent): unknown[] {
  if (event.preparation !== undefined) return [event.preparation];
  const keys = Object.keys(event);
  if (keys.length > 0) return [event];
  return [];
}

function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${sep}`)
  );
}

function refreshProposalOutputDir(
  memoryRoot: string,
  cwd: string,
  requested?: string,
): string {
  const outputDir =
    requested && requested.trim().length > 0
      ? isAbsolute(requested)
        ? requested
        : resolve(cwd, requested)
      : join(memoryRoot, REFRESH_PROPOSAL_DIR);
  const resolvedOutput = resolve(outputDir);
  if (!isInsideRoot(memoryRoot, resolvedOutput) || resolvedOutput === resolve(memoryRoot)) {
    throw new Error("memory refresh proposal output must be inside the memory root");
  }
  return resolvedOutput;
}

function renderResearchInjection(result: MemoryResearchResult): MemoryInjection | undefined {
  const lines = [
    result.answer.trim(),
    ...result.citations.map((path) => `- ${path}`),
  ].filter(Boolean);
  const selected: string[] = [];
  for (const line of lines) {
    if (selected.length >= INJECTION_MAX_LINES) break;
    const candidate = `${REACTIVE_ATTRIBUTION}\n${[...selected, line].join("\n")}`;
    if (Buffer.byteLength(candidate, "utf8") > INJECTION_MAX_BYTES) break;
    selected.push(line);
  }
  if (selected.length === 0) return undefined;
  return {
    text: `${REACTIVE_ATTRIBUTION}\n${selected.join("\n")}`,
    selectedLines: selected,
    truncated: selected.length < lines.length,
  };
}

export class MemoryExtensionCore {
  readonly config: RuntimeConfig;
  private ignoreForSession: boolean;
  private injectedForSession = false;
  private fs?: InjectionFileSystem;
  private worker?: MemoryWorkerRunner;
  private research: MemoryResearchRunner;
  private validator: MemoryValidatorRunner;
  private compactor: MemoryCompactorRunner;
  private state?: ExtensionStateSink;
  private scheduler: MemoryScheduler;
  private queue: MemoryBatchItem[] = [];
  private timer: unknown;
  private processing = false;
  private processingPromise?: Promise<void>;
  private itemSequence = 0;
  private batchSequence = 0;
  private env?: RuntimeEnv;

  constructor(options: MemoryExtensionCoreOptions) {
    this.config = resolveRuntimeConfig(options);
    this.ignoreForSession = this.config.ignore;
    this.env = options.env;
    this.fs = options.fs;
    this.worker = options.worker;
    this.research =
      options.research ??
      ((request) =>
        researchMemory({
          ...request,
          env: request.env ?? this.env ?? process.env,
        }));
    this.validator = options.validator ?? runReferenceValidator;
    this.compactor = options.compactor ?? compactMemoryDirectory;
    this.state = options.state;
    this.scheduler = options.scheduler ?? defaultScheduler();
    if (this.ignoreForSession) {
      this.recordModeAudit("ignore", "config");
    }
  }

  get ignored(): boolean {
    return this.ignoreForSession;
  }

  getStatus(): RuntimeConfig & { ignored: boolean } {
    return { ...this.config, ignored: this.ignoreForSession };
  }

  get pendingBatchItems(): number {
    return this.queue.length;
  }

  handleBeforeAgentStart(
    event: BeforeAgentStartEvent,
  ): BeforeAgentStartResult | undefined {
    if (!this.config.enabled) return undefined;
    const resumeMatch = matchedResumeMemoryRequest(event.prompt);
    if (resumeMatch) {
      const result = this.resumeMemory("prompt", { matchedPhrase: resumeMatch });
      if (result.status === "ignored-by-config") {
        return this.withIgnoreInstruction(event.systemPrompt);
      }
    }
    const ignoreMatch = matchedIgnoreMemoryRequest(event.prompt);
    if (ignoreMatch) {
      this.ignoreForSession = true;
      this.recordModeAudit("ignore", "prompt", {
        matchedPhrase: ignoreMatch,
        prompt: event.prompt,
      });
      return this.withIgnoreInstruction(event.systemPrompt);
    }
    if (this.ignoreForSession) return this.withIgnoreInstruction(event.systemPrompt);
    if (this.injectedForSession) return undefined;

    return this.renderIndexInjection(event);
  }

  async handleBeforeAgentStartAsync(
    event: BeforeAgentStartEvent,
  ): Promise<BeforeAgentStartResult | undefined> {
    if (!this.config.enabled) return undefined;
    const resumeMatch = matchedResumeMemoryRequest(event.prompt);
    if (resumeMatch) {
      const result = this.resumeMemory("prompt", { matchedPhrase: resumeMatch });
      if (result.status === "ignored-by-config") {
        return this.withIgnoreInstruction(event.systemPrompt);
      }
    }
    const ignoreMatch = matchedIgnoreMemoryRequest(event.prompt);
    if (ignoreMatch) {
      this.ignoreForSession = true;
      this.recordModeAudit("ignore", "prompt", {
        matchedPhrase: ignoreMatch,
        prompt: event.prompt,
      });
      return this.withIgnoreInstruction(event.systemPrompt);
    }
    if (this.ignoreForSession) return this.withIgnoreInstruction(event.systemPrompt);
    if (this.injectedForSession) return undefined;
    if (!this.config.reactive) return this.renderIndexInjection(event);

    const gate = buildReactiveMemoryGate({
      config: this.config,
      prompt: event.prompt,
      ignored: this.ignoreForSession,
      fs: this.fs,
    });
    if (!gate.shouldFire) {
      this.recordReactiveAudit({
        action: "skipped",
        topScore: gate.topScore,
        createdAt: this.scheduler.now(),
      });
      return this.appendInjection(event.systemPrompt, gate.injection);
    }

    if (this.config.dryRun) {
      this.recordReactiveAudit({
        action: "dry-run",
        reason: gate.reason,
        topScore: gate.topScore,
        wouldInject: Boolean(gate.injection),
        wouldInjectLines: gate.injection?.selectedLines ?? [],
        createdAt: this.scheduler.now(),
      });
      return undefined;
    }

    const result = await this.research({
      question: event.prompt,
      cwd: this.config.cwd,
      env: this.researchEnv(),
      homeDir: undefined,
    });
    if (result.found) {
      const injection = renderResearchInjection(result);
      this.recordReactiveAudit({
        action: "fired",
        reason: gate.reason,
        topScore: gate.topScore,
        found: true,
        status: result.status,
        citationCount: result.citations.length,
        wouldInject: Boolean(injection),
        createdAt: this.scheduler.now(),
      });
      return this.appendInjection(event.systemPrompt, injection);
    }

    this.recordReactiveAudit({
      action: result.status === "not-found" ? "not-found" : "failed",
      reason: gate.reason,
      topScore: gate.topScore,
      found: false,
      status: result.status,
      citationCount: result.citations.length,
      wouldInject: Boolean(gate.injection),
      error: result.error,
      createdAt: this.scheduler.now(),
    });
    return this.appendInjection(event.systemPrompt, gate.injection);
  }

  private renderIndexInjection(
    event: BeforeAgentStartEvent,
  ): BeforeAgentStartResult | undefined {
    const injection = buildMemoryInjection({
      config: this.config,
      prompt: event.prompt,
      ignored: this.ignoreForSession,
      fs: this.fs,
    });
    return this.appendInjection(event.systemPrompt, injection);
  }

  private appendInjection(
    systemPrompt: string,
    injection: MemoryInjection | undefined,
  ): BeforeAgentStartResult | undefined {
    if (!injection) return undefined;
    this.injectedForSession = true;
    this.recordInjectionAudit({
      selectedLineCount: injection.selectedLines.length,
      byteLength: Buffer.byteLength(injection.text, "utf8"),
      lineCap: INJECTION_MAX_LINES,
      byteCap: INJECTION_MAX_BYTES,
      truncated: injection.truncated,
      selectedLines: injection.selectedLines,
      createdAt: this.scheduler.now(),
    });

    const base = systemPrompt.trimEnd();
    return {
      systemPrompt: base ? `${base}\n\n${injection.text}` : injection.text,
      message: {
        customType: INJECTION_MESSAGE_TYPE,
        content: injection.text,
        display: true,
      },
    };
  }

  async handleAgentEnd(event: AgentEndEvent): Promise<void> {
    if (!this.enqueue("agent_end", event.messages ?? [])) return;
    if (this.queue.length >= this.config.maxBatchItems) {
      await this.flush("max_batch");
    } else {
      this.scheduleFlush();
    }
  }

  async handleSessionBeforeCompact(
    event: SessionBeforeCompactEvent,
  ): Promise<undefined> {
    if (
      !this.enqueue(
        "session_before_compact",
        compactEventMessages(event),
        auditPayloadSummary(event),
      )
    ) {
      return undefined;
    }
    await this.flush("session_before_compact");
    return undefined;
  }

  async flush(
    reason = "manual",
    options: FlushMemoryOptions = {},
  ): Promise<FlushMemoryResult> {
    if (!this.config.enabled) {
      return {
        status: "disabled",
        processedItems: 0,
        memoryChanges: 0,
        remainingItems: this.queue.length,
      };
    }
    if (this.ignoreForSession) {
      this.recordModeAudit("ignore", "flush", { reason });
      return {
        status: "ignored",
        processedItems: 0,
        memoryChanges: 0,
        remainingItems: this.queue.length,
      };
    }
    if (this.config.error || !this.config.memoryRoot) {
      return {
        status: "unavailable",
        processedItems: 0,
        memoryChanges: 0,
        remainingItems: this.queue.length,
        error: this.config.error ?? "memory root unavailable",
      };
    }

    this.clearTimer();
    if (this.processing) {
      await this.processingPromise;
      return {
        status: "idle",
        processedItems: 0,
        memoryChanges: 0,
        remainingItems: this.queue.length,
      };
    }

    let processedItems = 0;
    let memoryChanges = 0;
    let stoppedBy: WorkerBatchOutcome | undefined;
    while (this.queue.length > 0 && !this.processing) {
      const outcome = await this.processNextBatch(reason);
      if (!outcome) break;
      if (outcome.status !== "completed") {
        stoppedBy = outcome;
        break;
      }
      processedItems += outcome.itemCount;
      memoryChanges += outcome.memoryChanges;
      if (!options.drain && reason !== "session_before_compact") break;
      this.clearTimer();
    }

    if (stoppedBy) {
      return {
        status:
          stoppedBy.status === "refused"
            ? "refused"
            : stoppedBy.failureClass === "validation-failed"
              ? "validation-failed"
              : "failed",
        processedItems,
        memoryChanges,
        remainingItems: this.queue.length,
        error: stoppedBy.error,
      };
    }

    return {
      status: processedItems > 0 ? "flushed" : "idle",
      processedItems,
      memoryChanges,
      remainingItems: this.queue.length,
    };
  }

  async waitForIdle(): Promise<void> {
    await this.processingPromise;
  }

  async validateMemory(): Promise<ValidateMemoryResult> {
    if (!this.config.enabled) {
      return {
        status: "disabled",
        error: "memory validation suppressed: memory is disabled",
        outputTail: "",
      };
    }
    if (this.config.error || !this.config.memoryRoot) {
      return {
        status: "unavailable",
        error: this.config.error ?? "memory root unavailable",
        outputTail: "",
      };
    }

    try {
      const result = await this.validator(this.config.memoryRoot);
      return {
        status: result.exitCode === 0 ? "passed" : "failed",
        memoryRoot: this.config.memoryRoot,
        exitCode: result.exitCode,
        error: result.exitCode === 0 ? undefined : result.stderr || "validator failed",
        outputTail: outputTail(result.stdout, result.stderr, 1_600),
      };
    } catch (error) {
      return {
        status: "failed",
        memoryRoot: this.config.memoryRoot,
        error: error instanceof Error ? error.message : String(error),
        outputTail: "",
      };
    }
  }

  refreshMemory(options: RefreshMemoryOptions = {}): RefreshMemoryResult {
    if (!this.config.enabled) {
      return {
        status: "disabled",
        error: "memory refresh suppressed: memory is disabled",
        writtenFiles: [],
      };
    }
    if (this.ignoreForSession) {
      return {
        status: "ignored",
        error: "memory refresh suppressed: memory is ignored",
        writtenFiles: [],
      };
    }
    if (this.config.error || !this.config.memoryRoot) {
      return {
        status: "unavailable",
        error: this.config.error ?? "memory root unavailable",
        writtenFiles: [],
      };
    }

    try {
      const outputDir = refreshProposalOutputDir(
        this.config.memoryRoot,
        this.config.cwd,
        options.outputDir,
      );
      const report = this.compactor(this.config.memoryRoot, {
        ...options,
        outputDir,
        force: options.force ?? true,
        allowInsideRoot: true,
      });
      return {
        status: "proposal-created",
        memoryRoot: report.root,
        outputDir: report.outputDir,
        findingCount: report.findings.length,
        topicFileCount: report.topicFileCount,
        originalIndexLineCount: report.originalIndexLineCount,
        proposedIndexLineCount: report.proposedIndexLineCount,
        writtenFiles: report.writtenFiles,
      };
    } catch (error) {
      return {
        status: "failed",
        memoryRoot: this.config.memoryRoot,
        error: error instanceof Error ? error.message : String(error),
        writtenFiles: [],
      };
    }
  }

  resumeMemory(
    source: "command" | "prompt" = "command",
    detail?: { matchedPhrase?: string },
  ): ResumeMemoryResult {
    if (!this.config.enabled) return { status: "disabled" };
    if (this.config.ignore) {
      this.recordModeAudit("ignore", source, {
        matchedPhrase: detail?.matchedPhrase,
        reason: "PI_MEMORY_IGNORE=1",
      });
      return { status: "ignored-by-config" };
    }
    if (!this.ignoreForSession) return { status: "not-ignored" };
    this.ignoreForSession = false;
    this.recordModeAudit("resume", source, {
      matchedPhrase: detail?.matchedPhrase,
    });
    return { status: "resumed" };
  }

  async researchMemory(question: string): Promise<MemoryResearchResult> {
    if (!this.config.enabled) {
      return {
        status: "disabled",
        found: false,
        answer: "memory research skipped: disabled",
        citations: [],
      };
    }
    if (this.ignoreForSession) {
      return {
        status: "ignored",
        found: false,
        answer: "memory research skipped: ignored",
        citations: [],
      };
    }
    if (this.config.error || !this.config.memoryRoot) {
      return {
        status: "unavailable",
        found: false,
        answer: "memory research unavailable",
        citations: [],
        error: this.config.error ?? "memory root unavailable",
      };
    }
    return this.research({
      question,
      cwd: this.config.cwd,
      env: this.researchEnv(),
      homeDir: undefined,
    });
  }

  private researchEnv(): RuntimeEnv {
    return {
      ...(this.env ?? process.env),
      PI_MEMORY_ROOT: this.config.memoryRoot,
      PI_MEMORY_MODEL: this.config.model,
      PI_MEMORY_RESEARCH_MODEL: this.config.researchModel,
    };
  }

  private canProcessBatches(): boolean {
    return (
      this.config.enabled &&
      !this.config.error &&
      !this.ignoreForSession &&
      Boolean(this.config.memoryRoot)
    );
  }

  private enqueue(
    trigger: MemoryBatchItem["trigger"],
    messages: unknown[],
    payload?: AuditPayloadSummary,
  ): boolean {
    if (!this.canProcessBatches()) return false;
    const item: MemoryBatchItem = {
      id: `item-${++this.itemSequence}`,
      trigger,
      createdAt: this.scheduler.now(),
      messageCount: messages.length,
      messages,
      payload,
    };
    this.queue.push(item);
    this.state?.appendEntry(QUEUE_AUDIT_TYPE, {
      id: item.id,
      trigger: item.trigger,
      createdAt: item.createdAt,
      messageCount: item.messageCount,
      queueDepth: this.queue.length,
      payload,
    });
    return true;
  }

  private scheduleFlush(): void {
    if (this.timer !== undefined) this.clearTimer();
    this.timer = this.scheduler.setTimeout(() => {
      void this.flush("debounce");
    }, this.config.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async processNextBatch(
    reason: string,
  ): Promise<WorkerBatchOutcome | undefined> {
    const memoryRoot = this.config.memoryRoot;
    if (!memoryRoot) return undefined;
    const items = this.queue.slice(0, this.config.maxBatchItems);
    if (items.length === 0) return undefined;

    this.processing = true;
    let outcome: WorkerBatchOutcome | undefined;
    this.processingPromise = this.runWorkerBatch(reason, items, memoryRoot)
      .then((result) => {
        outcome = result;
        if (result.status === "completed") {
          this.queue.splice(0, items.length);
        }
      })
      .finally(() => {
        this.processing = false;
        this.processingPromise = undefined;
        if (outcome?.status === "completed" && this.queue.length > 0) {
          this.scheduleFlush();
        }
      });
    await this.processingPromise;
    return outcome;
  }

  private async runWorkerBatch(
    reason: string,
    items: MemoryBatchItem[],
    memoryRoot: string,
  ): Promise<WorkerBatchOutcome> {
    const batchId = `batch-${++this.batchSequence}`;
    if (!this.worker?.supportsEnv) {
      const error =
        "worker launch refused: selected pi.dev exec surface cannot prove PI_MEMORY_ENABLED=0 reaches the child process";
      this.recordWorkerAudit({
        batchId,
        reason,
        itemCount: items.length,
        items: this.auditItems(items),
        model: this.config.model,
        dryRun: this.config.dryRun,
        status: "refused",
        failureClass: "refused",
        retainedQueueCount: this.queue.length,
        changedPaths: [],
        proposedPaths: [],
        error,
        outputTail: "",
      });
      return {
        status: "refused",
        itemCount: items.length,
        memoryChanges: 0,
        error,
      };
    }

    const request: MemoryWorkerRequest = {
      batchId,
      items,
      cwd: this.config.cwd,
      memoryRoot,
      model: this.config.model,
      dryRun: this.config.dryRun,
      env: buildWorkerEnv({
        memoryRoot,
        model: this.config.model,
        dryRun: this.config.dryRun,
      }),
    };

    try {
      const applicatorOwned = isApplicatorOwnedWorkerRunner(this.worker);
      const beforeSnapshot = applicatorOwned
        ? undefined
        : takeMemoryRootSnapshot(memoryRoot);
      const result = await this.worker.run(request);
      if (beforeSnapshot) {
        const afterSnapshot = takeMemoryRootSnapshot(memoryRoot);
        if (memoryRootSnapshotChanged(beforeSnapshot, afterSnapshot)) {
          restoreMemoryRootSnapshot(memoryRoot, beforeSnapshot);
          const error =
            "worker run failed: injected worker runner mutated the memory root; writes must be applied by the memory-substrate applicator";
          const refused: MemoryWorkerResult = {
            exitCode: 1,
            stderr: error,
            changedPaths: [],
            proposedPaths: [],
          };
          this.recordWorkerResult(batchId, reason, items, refused, this.queue.length);
          return {
            status: "failed",
            itemCount: items.length,
            memoryChanges: 0,
            error,
            failureClass: "failed",
          };
        }
      }
      this.recordWorkerResult(
        batchId,
        reason,
        items,
        result,
        result.exitCode === 0
          ? Math.max(0, this.queue.length - items.length)
          : this.queue.length,
      );
      if (result.exitCode === 0) {
        return {
          status: "completed",
          itemCount: items.length,
          memoryChanges: countMemoryChanges(result),
        };
      }
      const failedValidation =
        result.validator !== undefined && result.validator.exitCode !== 0;
      return {
        status: "failed",
        itemCount: items.length,
        memoryChanges: 0,
        error: result.stderr || "worker failed",
        failureClass: failedValidation ? "validation-failed" : "failed",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordWorkerAudit({
        batchId,
        reason,
        itemCount: items.length,
        items: this.auditItems(items),
        model: this.config.model,
        dryRun: this.config.dryRun,
        status: "failed",
        failureClass: "failed",
        retainedQueueCount: this.queue.length,
        changedPaths: [],
        proposedPaths: [],
        error: message,
        outputTail: "",
      });
      return {
        status: "failed",
        itemCount: items.length,
        memoryChanges: 0,
        error: message,
      };
    }
  }

  private recordWorkerResult(
    batchId: string,
    reason: string,
    items: MemoryBatchItem[],
    result: MemoryWorkerResult,
    retainedQueueCount: number,
  ): void {
    const validatorTail = result.validator
      ? outputTail(result.validator.stdout, result.validator.stderr)
      : undefined;
    const failedValidation =
      result.exitCode !== 0 && result.validator !== undefined && result.validator.exitCode !== 0;
    const failedRun = result.exitCode !== 0;
    this.recordWorkerAudit({
      batchId,
      reason,
      itemCount: items.length,
      items: this.auditItems(items),
      model: this.config.model,
      dryRun: this.config.dryRun,
      status: failedRun ? "failed" : "completed",
      failureClass: failedRun
        ? failedValidation
          ? "validation-failed"
          : "failed"
        : undefined,
      retainedQueueCount,
      exitCode: result.exitCode,
      changedPaths: result.changedPaths ?? [],
      proposedPaths: result.proposedPaths ?? [],
      validatorResult: result.validator
        ? { exitCode: result.validator.exitCode, outputTail: validatorTail ?? "" }
        : undefined,
      error: result.exitCode === 0 ? undefined : result.stderr || "worker failed",
      outputTail: outputTail(result.stdout, result.stderr),
    });
  }

  private recordWorkerAudit(record: WorkerAuditRecord): void {
    this.state?.appendEntry(WORKER_AUDIT_TYPE, record);
  }

  private recordInjectionAudit(record: InjectionAuditRecord): void {
    this.state?.appendEntry(INJECTION_AUDIT_TYPE, record);
  }

  private recordReactiveAudit(record: ReactiveResearchAuditRecord): void {
    this.state?.appendEntry(REACTIVE_AUDIT_TYPE, record);
  }

  private auditItems(items: MemoryBatchItem[]): BatchItemAuditSummary[] {
    return items.map((item) => ({
      id: item.id,
      trigger: item.trigger,
      createdAt: item.createdAt,
      messageCount: item.messageCount,
      payload: item.payload as AuditPayloadSummary | undefined,
    }));
  }

  private withIgnoreInstruction(systemPrompt: string): BeforeAgentStartResult {
    const base = systemPrompt.trimEnd();
    return {
      systemPrompt: base
        ? `${base}\n\n${IGNORE_MODE_INSTRUCTION}`
        : IGNORE_MODE_INSTRUCTION,
    };
  }

  private recordModeAudit(
    mode: "ignore" | "resume",
    source: "config" | "prompt" | "flush" | "command",
    detail?: { matchedPhrase?: string; prompt?: string; reason?: string },
  ): void {
    this.state?.appendEntry(MODE_AUDIT_TYPE, {
      mode,
      source,
      matchedPhrase: detail?.matchedPhrase,
      reason: detail?.reason,
      prompt: detail?.prompt ? auditPayloadSummary(detail.prompt) : undefined,
      createdAt: this.scheduler.now(),
    });
  }
}
