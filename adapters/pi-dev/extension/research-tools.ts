import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

interface PiToolApi {
  registerTool?(definition: {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: unknown,
      signal: unknown,
      onUpdate: unknown,
      ctx: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

const MAX_READ_BYTES = 24 * 1024;
const MAX_GREP_MATCHES = 40;
const MAX_LIST_ENTRIES = 200;

function memoryRoot(): string {
  const root = process.env.PI_MEMORY_ROOT;
  if (!root) throw new Error("PI_MEMORY_ROOT is required");
  const realRoot = realpathSync(root);
  if (!statSync(realRoot).isDirectory()) {
    throw new Error("PI_MEMORY_ROOT must be a directory");
  }
  return realRoot;
}

function textParam(params: unknown, key: string, fallback = ""): string {
  if (!params || typeof params !== "object") return fallback;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : fallback;
}

function numberParam(params: unknown, key: string, fallback: number): number {
  if (!params || typeof params !== "object") return fallback;
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function rootPath(root: string, path: string): string {
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    throw new Error("memory path contains invalid characters");
  }
  if (isAbsolute(path)) throw new Error("memory path must be relative");
  const absolute = resolve(root, path || ".");
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("memory path escapes PI_MEMORY_ROOT");
  }
  if (!existsSync(absolute)) throw new Error("memory path does not exist");
  const real = realpathSync(absolute);
  const realRel = relative(root, real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error("memory path escapes PI_MEMORY_ROOT");
  }
  return real;
}

function markdownFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && extname(entry.name) === ".md") {
        files.push(rel);
      }
    }
  };
  visit(root);
  return files.sort();
}

function readBounded(path: string): { text: string; truncated: boolean } {
  const content = readFileSync(path, "utf8");
  if (Buffer.byteLength(content, "utf8") <= MAX_READ_BYTES) {
    return { text: content, truncated: false };
  }
  return { text: content.slice(0, MAX_READ_BYTES), truncated: true };
}

export default function memoryResearchTools(pi: PiToolApi): void {
  pi.registerTool?.({
    name: "memory_list",
    label: "Memory List",
    description: "List markdown memory files under PI_MEMORY_ROOT.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      const root = memoryRoot();
      const files = markdownFiles(root).slice(0, MAX_LIST_ENTRIES);
      return {
        content: [{ type: "text", text: files.join("\n") || "no memory files" }],
        details: { root, count: files.length },
      };
    },
  });

  pi.registerTool?.({
    name: "memory_read",
    label: "Memory Read",
    description: "Read a relative markdown file under PI_MEMORY_ROOT.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", description: "Relative markdown path under PI_MEMORY_ROOT." },
      },
    },
    async execute(_toolCallId, params) {
      const root = memoryRoot();
      const target = rootPath(root, textParam(params, "path"));
      if (!statSync(target).isFile() || extname(target) !== ".md") {
        throw new Error("memory_read only reads markdown files");
      }
      const result = readBounded(target);
      return {
        content: [{ type: "text", text: result.text }],
        details: { path: relative(root, target), truncated: result.truncated },
      };
    },
  });

  pi.registerTool?.({
    name: "memory_grep",
    label: "Memory Grep",
    description: "Search markdown memory files under PI_MEMORY_ROOT.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: { type: "string", description: "Case-insensitive literal search string." },
        limit: { type: "number", description: "Maximum matching lines to return." },
      },
    },
    async execute(_toolCallId, params) {
      const root = memoryRoot();
      const pattern = textParam(params, "pattern").trim().toLowerCase();
      if (!pattern) throw new Error("memory_grep requires a pattern");
      const limit = Math.min(MAX_GREP_MATCHES, numberParam(params, "limit", MAX_GREP_MATCHES));
      const matches: string[] = [];
      for (const relPath of markdownFiles(root)) {
        const absolute = rootPath(root, relPath);
        const content = readFileSync(absolute, "utf8");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!line.toLowerCase().includes(pattern)) continue;
          matches.push(`${relPath}:${index + 1}: ${line}`);
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
      }
      return {
        content: [{ type: "text", text: matches.join("\n") || "no matches" }],
        details: { pattern, count: matches.length, limit },
      };
    },
  });

  pi.registerTool?.({
    name: "memory_index",
    label: "Memory Index",
    description: "Read MEMORY.md from PI_MEMORY_ROOT.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    async execute() {
      const root = memoryRoot();
      const indexPath = rootPath(root, basename("MEMORY.md"));
      const result = readBounded(indexPath);
      return {
        content: [{ type: "text", text: result.text }],
        details: { path: "MEMORY.md", truncated: result.truncated },
      };
    },
  });
}
