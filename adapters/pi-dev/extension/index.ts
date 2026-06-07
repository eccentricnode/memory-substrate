import type {
  FlushMemoryResult,
  MemoryExtensionCore,
  SessionBeforeCompactEvent,
  ValidateMemoryResult,
} from "./core.ts";
import { MemoryExtensionCore as Core } from "./core.ts";
import {
  createLivePiMemoryWorkerRunner,
  type MemoryWorkerRunner,
} from "./worker.ts";

interface PiEventApi {
  on(event: "session_start", handler: (event: unknown, ctx: PiContext) => void): void;
  on(
    event: "before_agent_start",
    handler: (
      event: { prompt: string; systemPrompt: string },
      ctx: PiContext,
    ) => { systemPrompt?: string } | undefined,
  ): void;
  on(
    event: "agent_end",
    handler: (event: { messages?: unknown[] }, ctx: PiContext) => Promise<void>,
  ): void;
  on(
    event: "session_before_compact",
    handler: (event: SessionBeforeCompactEvent, ctx: PiContext) => Promise<undefined>,
  ): void;
  appendEntry?: (customType: string, data?: unknown) => void;
  registerCommand?(
    name: string,
    command: {
      description: string;
      handler: (args: string, ctx: PiContext) => void | Promise<void>;
    },
  ): void;
}

interface PiContext {
  cwd: string;
  memoryDisabled?: boolean;
  memoryDisabledReason?: string;
  memory?: {
    disabled?: boolean;
    disabledReason?: string;
  };
  substrate?: {
    memoryDisabled?: boolean;
    memoryDisabledReason?: string;
  };
  ui?: {
    setStatus?: (key: string, value: string | undefined) => void;
    notify?: (message: string, level?: "info" | "warn" | "error" | "success") => void;
  };
}

interface MemorySubstrateExtensionOptions {
  worker?: MemoryWorkerRunner;
  disabledSignal?: (ctx: PiContext) => boolean | string | undefined;
}

function createCore(
  ctx: PiContext,
  pi: PiEventApi,
  options: MemorySubstrateExtensionOptions,
): MemoryExtensionCore {
  return new Core({
    cwd: ctx.cwd,
    state: pi.appendEntry
      ? { appendEntry: (customType, data) => pi.appendEntry?.(customType, data) }
      : undefined,
    worker: options.worker ?? createLivePiMemoryWorkerRunner(),
    disabledReason: memoryDisabledReason(ctx, options),
  });
}

function hostContextDisabledReason(ctx: PiContext): string | undefined {
  if (ctx.memoryDisabled) {
    return ctx.memoryDisabledReason ?? "host substrate disabled memory";
  }
  if (ctx.memory?.disabled) {
    return ctx.memory.disabledReason ?? "host memory policy disabled memory";
  }
  if (ctx.substrate?.memoryDisabled) {
    return ctx.substrate.memoryDisabledReason ?? "host substrate disabled memory";
  }
  return undefined;
}

function memoryDisabledReason(
  ctx: PiContext,
  options: MemorySubstrateExtensionOptions,
): string | undefined {
  if (process.env.PI_MEMORY_ENABLED === "0") return "PI_MEMORY_ENABLED=0";
  const optionReason = options.disabledSignal?.(ctx);
  if (optionReason) {
    return typeof optionReason === "string"
      ? optionReason
      : "host disabled memory";
  }
  return hostContextDisabledReason(ctx);
}

function memoryDisabled(
  ctx: PiContext,
  options: MemorySubstrateExtensionOptions,
): boolean {
  return memoryDisabledReason(ctx, options) !== undefined;
}

function statusLine(core: MemoryExtensionCore): string {
  const status = core.getStatus();
  if (!status.enabled) return "memory: disabled";
  if (status.ignored) return "memory: ignored";
  if (status.error) return `memory: unavailable (${status.error})`;
  return `memory: ${status.dryRun ? "dry-run, " : ""}${status.memoryRoot}`;
}

function validationLevel(
  result: ValidateMemoryResult,
): "info" | "warn" | "error" | "success" {
  if (result.status === "passed") return "success";
  if (result.status === "disabled") return "info";
  return "error";
}

function validationMessage(result: ValidateMemoryResult): string {
  if (result.status === "disabled") return "memory validation skipped: disabled";
  if (result.status === "unavailable") {
    return `memory validation unavailable: ${result.error ?? "memory root unavailable"}`;
  }

  const headline =
    result.status === "passed"
      ? `memory validation passed: ${result.memoryRoot}`
      : `memory validation failed (${result.exitCode ?? "unknown"}): ${result.memoryRoot}`;
  return result.outputTail ? `${headline}\n${result.outputTail}` : headline;
}

function flushLevel(result: FlushMemoryResult): "info" | "warn" | "error" | "success" {
  if (result.status === "flushed") return "success";
  if (
    result.status === "unavailable" ||
    result.status === "failed" ||
    result.status === "refused"
  ) {
    return "error";
  }
  return "info";
}

function retainedQueueSuffix(result: FlushMemoryResult): string {
  if (result.remainingItems === 0) return "";
  return `; ${result.remainingItems} queued memory candidate(s) retained`;
}

function flushMessage(result: FlushMemoryResult): string {
  if (result.status === "disabled") return "memory flush skipped: disabled";
  if (result.status === "ignored") return "memory flush skipped: ignored";
  if (result.status === "unavailable") {
    return `memory flush unavailable: ${result.error ?? "memory root unavailable"}`;
  }
  if (result.status === "refused") {
    return `memory flush refused: ${result.error ?? "worker refused"}${retainedQueueSuffix(result)}`;
  }
  if (result.status === "failed") {
    return `memory flush failed: ${result.error ?? "worker failed"}${retainedQueueSuffix(result)}`;
  }
  if (result.status === "idle") {
    return "memory flush complete: no queued memory candidates";
  }

  const suffix =
    result.remainingItems > 0 ? `, ${result.remainingItems} still queued` : "";
  return `memory flush complete: processed ${result.processedItems} queued memory candidate(s)${suffix}`;
}

export default function memorySubstrateExtension(
  pi: PiEventApi,
  options: MemorySubstrateExtensionOptions = {},
) {
  let core: MemoryExtensionCore | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (memoryDisabled(ctx, options)) {
      core = undefined;
      ctx.ui?.setStatus?.("memory-substrate", "memory: disabled");
      return;
    }
    core = createCore(ctx, pi, options);
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (memoryDisabled(ctx, options)) {
      core = undefined;
      ctx.ui?.setStatus?.("memory-substrate", "memory: disabled");
      return undefined;
    }
    core ??= createCore(ctx, pi, options);
    const result = core.handleBeforeAgentStart(event);
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
    return result;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (memoryDisabled(ctx, options)) {
      core = undefined;
      ctx.ui?.setStatus?.("memory-substrate", "memory: disabled");
      return;
    }
    core ??= createCore(ctx, pi, options);
    await core.handleAgentEnd(event);
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (memoryDisabled(ctx, options)) {
      core = undefined;
      ctx.ui?.setStatus?.("memory-substrate", "memory: disabled");
      return undefined;
    }
    core ??= createCore(ctx, pi, options);
    await core.handleSessionBeforeCompact(event);
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
    return undefined;
  });

  pi.registerCommand?.("memory-status", {
    description: "Show memory-substrate mode and resolved memory root",
    handler: (_args, ctx) => {
      if (memoryDisabled(ctx, options)) {
        core = undefined;
        ctx.ui?.notify?.("memory: disabled", "info");
        return;
      }
      core ??= createCore(ctx, pi, options);
      ctx.ui?.notify?.(statusLine(core), "info");
    },
  });

  pi.registerCommand?.("memory-flush", {
    description: "Flush queued memory candidates now",
    handler: async (_args, ctx) => {
      if (memoryDisabled(ctx, options)) {
        core = undefined;
        ctx.ui?.notify?.("memory flush skipped: disabled", "info");
        return;
      }
      core ??= createCore(ctx, pi, options);
      const result = await core.flush("manual_command", { drain: true });
      ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
      ctx.ui?.notify?.(flushMessage(result), flushLevel(result));
    },
  });

  pi.registerCommand?.("memory-validate", {
    description: "Validate the resolved memory root with memory-substrate",
    handler: async (_args, ctx) => {
      if (memoryDisabled(ctx, options)) {
        core = undefined;
        ctx.ui?.notify?.("memory validation skipped: disabled", "info");
        return;
      }
      core ??= createCore(ctx, pi, options);
      const result = await core.validateMemory();
      ctx.ui?.notify?.(validationMessage(result), validationLevel(result));
    },
  });
}
