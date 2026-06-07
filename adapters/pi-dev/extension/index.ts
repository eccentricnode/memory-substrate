import type {
  MemoryExtensionCore,
  SessionBeforeCompactEvent,
} from "./core.ts";
import { MemoryExtensionCore as Core } from "./core.ts";
import { unsupportedPiExecWorkerRunner } from "./worker.ts";

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
    command: { description: string; handler: (args: string, ctx: PiContext) => void },
  ): void;
}

interface PiContext {
  cwd: string;
  ui?: {
    setStatus?: (key: string, value: string | undefined) => void;
    notify?: (message: string, level?: "info" | "warn" | "error" | "success") => void;
  };
}

function createCore(ctx: PiContext, pi: PiEventApi): MemoryExtensionCore {
  return new Core({
    cwd: ctx.cwd,
    state: pi.appendEntry
      ? { appendEntry: (customType, data) => pi.appendEntry?.(customType, data) }
      : undefined,
    worker: unsupportedPiExecWorkerRunner,
  });
}

function statusLine(core: MemoryExtensionCore): string {
  const status = core.getStatus();
  if (!status.enabled) return "memory: disabled";
  if (status.ignored) return "memory: ignored";
  if (status.error) return `memory: unavailable (${status.error})`;
  return `memory: ${status.dryRun ? "dry-run, " : ""}${status.memoryRoot}`;
}

export default function memorySubstrateExtension(pi: PiEventApi) {
  let core: MemoryExtensionCore | undefined;

  pi.on("session_start", (_event, ctx) => {
    core = createCore(ctx, pi);
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
  });

  pi.on("before_agent_start", (event, ctx) => {
    core ??= createCore(ctx, pi);
    const result = core.handleBeforeAgentStart(event);
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
    return result;
  });

  pi.on("agent_end", async (event, ctx) => {
    core ??= createCore(ctx, pi);
    await core.handleAgentEnd(event);
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
  });

  pi.on("session_before_compact", async (event, ctx) => {
    core ??= createCore(ctx, pi);
    await core.handleSessionBeforeCompact(event);
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
    return undefined;
  });

  pi.registerCommand?.("memory-status", {
    description: "Show memory-substrate mode and resolved memory root",
    handler: (_args, ctx) => {
      core ??= createCore(ctx, pi);
      ctx.ui?.notify?.(statusLine(core), "info");
    },
  });
}
