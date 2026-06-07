import type { MemoryExtensionCore } from "./core.ts";
import { MemoryExtensionCore as Core } from "./core.ts";

interface PiEventApi {
  on(event: "session_start", handler: (event: unknown, ctx: PiContext) => void): void;
  on(
    event: "before_agent_start",
    handler: (
      event: { prompt: string; systemPrompt: string },
      ctx: PiContext,
    ) => { systemPrompt?: string } | undefined,
  ): void;
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
    core = new Core({ cwd: ctx.cwd });
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
  });

  pi.on("before_agent_start", (event, ctx) => {
    core ??= new Core({ cwd: ctx.cwd });
    const result = core.handleBeforeAgentStart(event);
    ctx.ui?.setStatus?.("memory-substrate", statusLine(core));
    return result;
  });

  pi.registerCommand?.("memory-status", {
    description: "Show memory-substrate mode and resolved memory root",
    handler: (_args, ctx) => {
      core ??= new Core({ cwd: ctx.cwd });
      ctx.ui?.notify?.(statusLine(core), "info");
    },
  });
}
