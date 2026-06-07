import type { RuntimeEnv } from "./config.ts";

export type BatchTrigger = "agent_end" | "session_before_compact";
export type WorkerRunStatus = "completed" | "failed" | "refused";

export interface MemoryBatchItem {
  id: string;
  trigger: BatchTrigger;
  createdAt: number;
  messageCount: number;
  messages?: unknown[];
}

export interface MemoryWorkerRequest {
  batchId: string;
  items: MemoryBatchItem[];
  cwd: string;
  memoryRoot: string;
  model: string;
  dryRun: boolean;
  env: RuntimeEnv;
}

export interface MemoryWorkerResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  changedPaths?: string[];
  proposedPaths?: string[];
  validator?: {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  };
}

export interface MemoryWorkerRunner {
  supportsEnv: boolean;
  run(request: MemoryWorkerRequest): Promise<MemoryWorkerResult>;
}

export const RECURSION_GUARD_ENV: RuntimeEnv = {
  PI_MEMORY_ENABLED: "0",
};

export function buildWorkerEnv(request: {
  memoryRoot: string;
  model: string;
  dryRun: boolean;
}): RuntimeEnv {
  return {
    ...RECURSION_GUARD_ENV,
    PI_MEMORY_ROOT: request.memoryRoot,
    PI_MEMORY_MODEL: request.model,
    PI_MEMORY_DRY_RUN: request.dryRun ? "1" : "0",
  };
}

export function outputTail(stdout = "", stderr = "", maxChars = 800): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (combined.length <= maxChars) return combined;
  return combined.slice(combined.length - maxChars);
}

export const unsupportedPiExecWorkerRunner: MemoryWorkerRunner = {
  supportsEnv: false,
  async run() {
    return {
      exitCode: 1,
      stderr:
        "pi.exec in this pi.dev version does not support child environment overrides; refusing worker spawn",
    };
  },
};
