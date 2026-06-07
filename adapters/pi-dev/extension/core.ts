import { resolveRuntimeConfig, type RuntimeConfig, type RuntimeEnv } from "./config.ts";
import {
  buildMemoryInjection,
  INJECTION_MAX_BYTES,
  INJECTION_MAX_LINES,
  matchedIgnoreMemoryRequest,
  type InjectionFileSystem,
} from "./injection.ts";
import {
  buildWorkerEnv,
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
  validator?: MemoryValidatorRunner;
  state?: ExtensionStateSink;
  scheduler?: MemoryScheduler;
}

export type MemoryValidatorRunner = (
  memoryRoot: string,
) => Promise<MemoryValidationResult>;

export interface BeforeAgentStartEvent {
  prompt: string;
  systemPrompt: string;
}

export interface BeforeAgentStartResult {
  systemPrompt?: string;
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
    | "refused";
  processedItems: number;
  remainingItems: number;
  error?: string;
}

export interface FlushMemoryOptions {
  drain?: boolean;
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

const QUEUE_AUDIT_TYPE = "memory-substrate-queue";
const WORKER_AUDIT_TYPE = "memory-substrate-worker-run";
const MODE_AUDIT_TYPE = "memory-substrate-mode";
const INJECTION_AUDIT_TYPE = "memory-substrate-injection";
const AUDIT_STRING_CAP = 300;
const AUDIT_ARRAY_ITEM_CAP = 5;
const AUDIT_OBJECT_KEY_CAP = 12;
const AUDIT_DEPTH_CAP = 3;
const AUDIT_PREVIEW_CAP = 1_200;
const IGNORE_MODE_INSTRUCTION =
  "Memory ignore mode is active for this session. Do not cite, compare against, or apply durable memory that may already be present in context.";

interface WorkerBatchOutcome {
  status: WorkerRunStatus;
  itemCount: number;
  error?: string;
}

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

function compactEventMessages(event: SessionBeforeCompactEvent): unknown[] {
  if (event.preparation !== undefined) return [event.preparation];
  const keys = Object.keys(event);
  if (keys.length > 0) return [event];
  return [];
}

export class MemoryExtensionCore {
  readonly config: RuntimeConfig;
  private ignoreForSession: boolean;
  private fs?: InjectionFileSystem;
  private worker?: MemoryWorkerRunner;
  private validator: MemoryValidatorRunner;
  private state?: ExtensionStateSink;
  private scheduler: MemoryScheduler;
  private queue: MemoryBatchItem[] = [];
  private timer: unknown;
  private processing = false;
  private processingPromise?: Promise<void>;
  private itemSequence = 0;
  private batchSequence = 0;

  constructor(options: MemoryExtensionCoreOptions) {
    this.config = resolveRuntimeConfig(options);
    this.ignoreForSession = this.config.ignore;
    this.fs = options.fs;
    this.worker = options.worker;
    this.validator = options.validator ?? runReferenceValidator;
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

    const injection = buildMemoryInjection({
      config: this.config,
      prompt: event.prompt,
      ignored: this.ignoreForSession,
      fs: this.fs,
    });
    if (!injection) return undefined;

    this.recordInjectionAudit({
      selectedLineCount: injection.selectedLines.length,
      byteLength: Buffer.byteLength(injection.text, "utf8"),
      lineCap: INJECTION_MAX_LINES,
      byteCap: INJECTION_MAX_BYTES,
      truncated: injection.truncated,
      selectedLines: injection.selectedLines,
      createdAt: this.scheduler.now(),
    });

    const base = event.systemPrompt.trimEnd();
    return {
      systemPrompt: base ? `${base}\n\n${injection.text}` : injection.text,
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
        remainingItems: this.queue.length,
      };
    }
    if (this.ignoreForSession) {
      this.recordModeAudit("ignore", "flush", { reason });
      return {
        status: "ignored",
        processedItems: 0,
        remainingItems: this.queue.length,
      };
    }
    if (this.config.error || !this.config.memoryRoot) {
      return {
        status: "unavailable",
        processedItems: 0,
        remainingItems: this.queue.length,
        error: this.config.error ?? "memory root unavailable",
      };
    }

    this.clearTimer();
    if (this.processing) {
      await this.processingPromise;
    }

    let processedItems = 0;
    let stoppedBy: WorkerBatchOutcome | undefined;
    while (this.queue.length > 0 && !this.processing) {
      const outcome = await this.processNextBatch(reason);
      if (!outcome) break;
      if (outcome.status !== "completed") {
        stoppedBy = outcome;
        break;
      }
      processedItems += outcome.itemCount;
      if (!options.drain && reason !== "session_before_compact") break;
      this.clearTimer();
    }

    if (stoppedBy) {
      return {
        status: stoppedBy.status === "refused" ? "refused" : "failed",
        processedItems,
        remainingItems: this.queue.length,
        error: stoppedBy.error,
      };
    }

    return {
      status: processedItems > 0 ? "flushed" : "idle",
      processedItems,
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
        changedPaths: [],
        proposedPaths: [],
        error,
        outputTail: "",
      });
      return { status: "refused", itemCount: items.length, error };
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
      const result = await this.worker.run(request);
      this.recordWorkerResult(batchId, reason, items, result);
      if (result.exitCode === 0) {
        return { status: "completed", itemCount: items.length };
      }
      return {
        status: "failed",
        itemCount: items.length,
        error: result.stderr || "worker failed",
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
        changedPaths: [],
        proposedPaths: [],
        error: message,
        outputTail: "",
      });
      return { status: "failed", itemCount: items.length, error: message };
    }
  }

  private recordWorkerResult(
    batchId: string,
    reason: string,
    items: MemoryBatchItem[],
    result: MemoryWorkerResult,
  ): void {
    const validatorTail = result.validator
      ? outputTail(result.validator.stdout, result.validator.stderr)
      : undefined;
    this.recordWorkerAudit({
      batchId,
      reason,
      itemCount: items.length,
      items: this.auditItems(items),
      model: this.config.model,
      dryRun: this.config.dryRun,
      status: result.exitCode === 0 ? "completed" : "failed",
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
    mode: "ignore",
    source: "config" | "prompt" | "flush",
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
