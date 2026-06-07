import { resolveRuntimeConfig, type RuntimeConfig, type RuntimeEnv } from "./config.ts";
import {
  buildMemoryInjection,
  detectsIgnoreMemoryRequest,
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
}

export interface WorkerAuditRecord {
  batchId: string;
  reason: string;
  itemCount: number;
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

const QUEUE_AUDIT_TYPE = "memory-substrate-queue";
const WORKER_AUDIT_TYPE = "memory-substrate-worker-run";

function defaultScheduler(): MemoryScheduler {
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
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
    if (detectsIgnoreMemoryRequest(event.prompt)) {
      this.ignoreForSession = true;
      return undefined;
    }
    if (this.ignoreForSession) return undefined;

    const injection = buildMemoryInjection({
      config: this.config,
      prompt: event.prompt,
      ignored: this.ignoreForSession,
      fs: this.fs,
    });
    if (!injection) return undefined;

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
    _event: SessionBeforeCompactEvent,
  ): Promise<undefined> {
    if (!this.enqueue("session_before_compact", [])) return undefined;
    await this.flush("session_before_compact");
    return undefined;
  }

  async flush(reason = "manual"): Promise<void> {
    if (!this.canProcessBatches()) return;
    this.clearTimer();
    if (this.processing) {
      await this.processingPromise;
    }
    while (this.queue.length > 0 && !this.processing) {
      await this.processNextBatch(reason);
      if (reason !== "session_before_compact") break;
    }
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

  private enqueue(trigger: MemoryBatchItem["trigger"], messages: unknown[]): boolean {
    if (!this.canProcessBatches()) return false;
    const item: MemoryBatchItem = {
      id: `item-${++this.itemSequence}`,
      trigger,
      createdAt: this.scheduler.now(),
      messageCount: messages.length,
      messages,
    };
    this.queue.push(item);
    this.state?.appendEntry(QUEUE_AUDIT_TYPE, {
      id: item.id,
      trigger: item.trigger,
      createdAt: item.createdAt,
      messageCount: item.messageCount,
      queueDepth: this.queue.length,
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

  private async processNextBatch(reason: string): Promise<void> {
    const memoryRoot = this.config.memoryRoot;
    if (!memoryRoot) return;
    const items = this.queue.splice(0, this.config.maxBatchItems);
    if (items.length === 0) return;

    this.processing = true;
    this.processingPromise = this.runWorkerBatch(reason, items, memoryRoot).finally(
      () => {
        this.processing = false;
        this.processingPromise = undefined;
        if (this.queue.length > 0) this.scheduleFlush();
      },
    );
    await this.processingPromise;
  }

  private async runWorkerBatch(
    reason: string,
    items: MemoryBatchItem[],
    memoryRoot: string,
  ): Promise<void> {
    const batchId = `batch-${++this.batchSequence}`;
    if (!this.worker?.supportsEnv) {
      this.recordWorkerAudit({
        batchId,
        reason,
        itemCount: items.length,
        model: this.config.model,
        dryRun: this.config.dryRun,
        status: "refused",
        changedPaths: [],
        proposedPaths: [],
        error:
          "worker launch refused: selected pi.dev exec surface cannot prove PI_MEMORY_ENABLED=0 reaches the child process",
        outputTail: "",
      });
      return;
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
      this.recordWorkerResult(batchId, reason, items.length, result);
    } catch (error) {
      this.recordWorkerAudit({
        batchId,
        reason,
        itemCount: items.length,
        model: this.config.model,
        dryRun: this.config.dryRun,
        status: "failed",
        changedPaths: [],
        proposedPaths: [],
        error: error instanceof Error ? error.message : String(error),
        outputTail: "",
      });
    }
  }

  private recordWorkerResult(
    batchId: string,
    reason: string,
    itemCount: number,
    result: MemoryWorkerResult,
  ): void {
    const validatorTail = result.validator
      ? outputTail(result.validator.stdout, result.validator.stderr)
      : undefined;
    this.recordWorkerAudit({
      batchId,
      reason,
      itemCount,
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
}
