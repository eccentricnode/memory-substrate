import { resolveRuntimeConfig, type RuntimeConfig, type RuntimeEnv } from "./config.ts";
import {
  buildMemoryInjection,
  detectsIgnoreMemoryRequest,
  type InjectionFileSystem,
} from "./injection.ts";

export interface MemoryExtensionCoreOptions {
  cwd: string;
  env?: RuntimeEnv;
  homeDir?: string;
  fs?: InjectionFileSystem;
}

export interface BeforeAgentStartEvent {
  prompt: string;
  systemPrompt: string;
}

export interface BeforeAgentStartResult {
  systemPrompt?: string;
}

export class MemoryExtensionCore {
  readonly config: RuntimeConfig;
  private ignoreForSession: boolean;
  private fs?: InjectionFileSystem;

  constructor(options: MemoryExtensionCoreOptions) {
    this.config = resolveRuntimeConfig(options);
    this.ignoreForSession = this.config.ignore;
    this.fs = options.fs;
  }

  get ignored(): boolean {
    return this.ignoreForSession;
  }

  getStatus(): RuntimeConfig & { ignored: boolean } {
    return { ...this.config, ignored: this.ignoreForSession };
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
}
