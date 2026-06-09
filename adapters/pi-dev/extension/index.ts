import type {
  FlushMemoryResult,
  MemoryExtensionCore,
  RefreshMemoryResult,
  SessionBeforeCompactEvent,
  ValidateMemoryResult,
} from "./core.ts";
import { MemoryExtensionCore as Core } from "./core.ts";
import {
  createLivePiMemoryWorkerRunner,
  type MemoryWorkerRunner,
} from "./worker.ts";
import {
  researchMemory,
  type MemoryResearchOptions,
  type MemoryResearchResult,
} from "./research.ts";

interface PiEventApi {
  on(event: "session_start", handler: (event: unknown, ctx: PiContext) => void): void;
  on(
    event: "before_agent_start",
    handler: (
      event: { prompt: string; systemPrompt: string },
      ctx: PiContext,
    ) => { systemPrompt?: string } | undefined | Promise<{ systemPrompt?: string } | undefined>,
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
  registerTool?(definition: {
    name: string;
    label?: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute(
      toolCallId: string,
      params: unknown,
      signal: unknown,
      onUpdate: unknown,
      ctx: PiContext,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
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
  research?: MemoryResearchOptions;
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
    research: (request) => researchMemory(request, options.research),
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
  if (result.status === "disabled" || result.status === "ignored") return "info";
  return "error";
}

function validationMessage(result: ValidateMemoryResult): string {
  if (result.status === "disabled") return "memory validation skipped: disabled";
  if (result.status === "ignored") return "memory validation skipped: ignored";
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
    result.status === "validation-failed" ||
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
  if (result.status === "validation-failed") {
    return `memory flush validation failed: ${result.error ?? "validator failed after memory write"}${retainedQueueSuffix(result)}`;
  }
  if (result.status === "idle") {
    return "memory flush complete: no queued memory candidates";
  }

  const suffix =
    result.remainingItems > 0 ? `, ${result.remainingItems} still queued` : "";
  if (result.memoryChanges === 0) {
    return `memory flush complete: processed ${result.processedItems} queued memory candidate(s), no memory changes accepted${suffix}`;
  }
  return [
    `memory flush complete: processed ${result.processedItems} queued memory candidate(s)`,
    `${result.memoryChanges} memory path change(s) accepted or proposed${suffix}`,
  ].join("; ");
}

function refreshLevel(
  result: RefreshMemoryResult,
): "info" | "warn" | "error" | "success" {
  if (result.status === "proposal-created") {
    return result.findingCount && result.findingCount > 0 ? "warn" : "success";
  }
  if (result.status === "disabled" || result.status === "ignored") return "info";
  return "error";
}

function refreshMessage(result: RefreshMemoryResult): string {
  if (result.status === "disabled") return "memory refresh skipped: disabled";
  if (result.status === "ignored") return "memory refresh skipped: ignored";
  if (result.status === "unavailable") {
    return `memory refresh unavailable: ${result.error ?? "memory root unavailable"}`;
  }
  if (result.status === "failed") {
    return `memory refresh failed: ${result.error ?? "compactor failed"}`;
  }

  return [
    `memory refresh proposal created: ${result.outputDir}`,
    `${result.topicFileCount ?? 0} topic file(s), ${result.findingCount ?? 0} finding(s)`,
    `index ${result.originalIndexLineCount ?? 0} -> ${result.proposedIndexLineCount ?? 0} line(s)`,
    "durable memory was not modified",
  ].join("\n");
}

function refreshOutputDir(args: string): string | undefined {
  const trimmed = args.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function researchLevel(
  result: MemoryResearchResult,
): "info" | "warn" | "error" | "success" {
  if (result.status === "found") return "success";
  if (
    result.status === "disabled" ||
    result.status === "ignored" ||
    result.status === "not-found"
  ) {
    return "info";
  }
  return "error";
}

function researchMessage(result: MemoryResearchResult): string {
  if (result.status === "disabled") return "memory research skipped: disabled";
  if (result.status === "ignored") return "memory research skipped: ignored";
  if (result.status === "unavailable") {
    return `memory research unavailable: ${result.error ?? "memory root unavailable"}`;
  }
  if (result.status === "failed") {
    return `memory research failed: ${result.error ?? "sub-agent failed"}`;
  }
  const citations =
    result.citations.length > 0
      ? `\n\nCitations:\n${result.citations.map((path) => `- ${path}`).join("\n")}`
      : "";
  return `${result.answer}${citations}`;
}

function researchQuestionFromParams(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const question = (params as { question?: unknown }).question;
  return typeof question === "string" ? question : "";
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

  pi.on("before_agent_start", async (event, ctx) => {
    if (memoryDisabled(ctx, options)) {
      core = undefined;
      ctx.ui?.setStatus?.("memory-substrate", "memory: disabled");
      return undefined;
    }
    core ??= createCore(ctx, pi, options);
    const result = await core.handleBeforeAgentStartAsync(event);
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

  pi.registerCommand?.("memory-refresh", {
    description: "Write a reviewable memory compaction proposal under the memory root",
    handler: (args, ctx) => {
      if (memoryDisabled(ctx, options)) {
        core = undefined;
        ctx.ui?.notify?.("memory refresh skipped: disabled", "info");
        return;
      }
      core ??= createCore(ctx, pi, options);
      const result = core.refreshMemory({ outputDir: refreshOutputDir(args) });
      ctx.ui?.notify?.(refreshMessage(result), refreshLevel(result));
    },
  });

  pi.registerCommand?.("memory-research", {
    description: "Research durable memory in a read-only sub-agent",
    handler: async (args, ctx) => {
      if (memoryDisabled(ctx, options)) {
        core = undefined;
        ctx.ui?.notify?.("memory research skipped: disabled", "info");
        return;
      }
      const result = await researchMemory(
        { question: args, cwd: ctx.cwd, env: process.env },
        options.research,
      );
      ctx.ui?.notify?.(researchMessage(result), researchLevel(result));
    },
  });

  pi.registerTool?.({
    name: "memory_research",
    label: "Memory Research",
    description:
      "Research durable memory in a read-only sub-agent and return a synthesis with citations.",
    promptSnippet: "Research durable memory without loading raw memory files into context",
    promptGuidelines: [
      "Use memory_research when the user asks about prior durable memory or previous decisions that are not already visible in context.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: {
          type: "string",
          description: "The memory question to answer from durable memory.",
        },
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (memoryDisabled(ctx, options)) {
        return {
          content: [{ type: "text", text: "memory research skipped: disabled" }],
          details: { status: "disabled", found: false, citations: [] },
        };
      }
      const result = await researchMemory(
        { question: researchQuestionFromParams(params), cwd: ctx.cwd, env: process.env },
        options.research,
      );
      return {
        content: [{ type: "text", text: researchMessage(result) }],
        details: result,
      };
    },
  });
}
