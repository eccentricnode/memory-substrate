import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const DEFAULT_MEMORY_ROOT = "~/.memory";
export const DEFAULT_WORKER_MODEL = "claude-haiku-4-5";
export const DEFAULT_DEBOUNCE_MS = 3_000;
export const DEFAULT_MAX_BATCH_ITEMS = 8;

export interface RuntimeEnv {
  [name: string]: string | undefined;
}

export interface RuntimeConfigInput {
  cwd: string;
  env?: RuntimeEnv;
  homeDir?: string;
}

export interface RuntimeConfig {
  enabled: boolean;
  dryRun: boolean;
  ignore: boolean;
  cwd: string;
  memoryRoot?: string;
  model: string;
  debounceMs: number;
  maxBatchItems: number;
  error?: string;
}

function envFlag(value: string | undefined, enabledValue: string): boolean {
  return value === enabledValue;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
  return path;
}

export function resolveMemoryRoot(
  rawRoot: string | undefined,
  cwd: string,
  homeDir = homedir(),
): { ok: true; path: string } | { ok: false; error: string } {
  const configured = rawRoot?.trim() || DEFAULT_MEMORY_ROOT;
  const expanded = expandHome(configured, homeDir);
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);

  try {
    if (!existsSync(absolute)) {
      return { ok: false, error: `memory root does not exist: ${absolute}` };
    }
    return { ok: true, path: realpathSync(absolute) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `memory root is not canonicalizable: ${detail}` };
  }
}

export function resolveRuntimeConfig(input: RuntimeConfigInput): RuntimeConfig {
  const env = input.env ?? process.env;
  const enabled = env.PI_MEMORY_ENABLED !== "0";
  const base: RuntimeConfig = {
    enabled,
    dryRun: envFlag(env.PI_MEMORY_DRY_RUN, "1"),
    ignore: envFlag(env.PI_MEMORY_IGNORE, "1"),
    cwd: input.cwd,
    model: env.PI_MEMORY_MODEL?.trim() || DEFAULT_WORKER_MODEL,
    debounceMs: parsePositiveInteger(
      env.PI_MEMORY_DEBOUNCE_MS,
      DEFAULT_DEBOUNCE_MS,
    ),
    maxBatchItems: parsePositiveInteger(
      env.PI_MEMORY_MAX_BATCH_ITEMS,
      DEFAULT_MAX_BATCH_ITEMS,
    ),
  };

  if (!enabled) return base;

  const root = resolveMemoryRoot(
    env.PI_MEMORY_ROOT,
    input.cwd,
    input.homeDir ?? homedir(),
  );
  if (!root.ok) return { ...base, error: root.error };
  return { ...base, memoryRoot: root.path };
}
