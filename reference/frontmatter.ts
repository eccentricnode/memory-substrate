// Strict memory-substrate frontmatter parser.
//
// Supported YAML subset: a leading frontmatter block, top-level string scalars,
// one-level nested string scalars under `metadata:`, quotes around scalar values,
// blank lines, comments, and inline comments on unquoted values. The substrate
// schema only needs those forms; unsupported YAML is left unparsed so callers fail
// closed through normal required-field validation.

export interface ParsedMemoryFrontmatter {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

function closingDelimiterIndex(content: string, start: number): number {
  const lfIndex = content.indexOf("\n---\n", start);
  const crlfIndex = content.indexOf("\r\n---\r\n", start);
  if (lfIndex === -1) return crlfIndex;
  if (crlfIndex === -1) return lfIndex;
  return Math.min(lfIndex, crlfIndex);
}

function frontmatterBody(content: string): { body?: string; error?: string } {
  const opening = content.match(/^---\r?\n/);
  if (!opening) return { error: "no frontmatter delimiter" };
  const start = opening[0].length;
  const end = closingDelimiterIndex(content, start);
  if (end === -1) return { error: "unterminated frontmatter block" };
  return { body: content.slice(start, end) };
}

function stripUnquotedInlineComment(value: string): string {
  const comment = value.match(/(?:^|\s)#/);
  if (comment?.index === undefined) return value;
  return value.slice(0, comment.index).trimEnd();
}

function parseScalar(raw: string): string | undefined {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === "\"" || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  if (trimmed === "|" || trimmed === ">" || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return undefined;
  }
  return stripUnquotedInlineComment(trimmed).trim();
}

export function parseMemoryFrontmatter(content: string): ParsedMemoryFrontmatter {
  const extracted = frontmatterBody(content);
  if (extracted.error) return { ok: false, error: extracted.error };

  const data: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};
  let activeBlock: "metadata" | undefined;

  for (const raw of (extracted.body ?? "").split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const blockHeader = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(?:#.*)?$/);
    if (blockHeader?.[1] === "metadata") {
      activeBlock = "metadata";
      continue;
    }

    const match = raw.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;

    const indent = match[1] ?? "";
    const key = match[2];
    const value = match[3] ?? "";
    if (!key) continue;
    if (indent.length === 0) activeBlock = undefined;

    if (indent.length > 0 && activeBlock === "metadata") {
      const parsed = parseScalar(value);
      if (parsed !== undefined) metadata[key] = parsed;
    } else if (indent.length === 0) {
      const parsed = parseScalar(value);
      if (parsed !== undefined) data[key] = parsed;
    }
  }

  if (Object.keys(metadata).length > 0) data.metadata = metadata;
  return { ok: true, data };
}

export function memoryFrontmatterField(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value : undefined;
}

export function memoryFrontmatterMetadataType(
  data: Record<string, unknown>,
): string | undefined {
  const metadata = data.metadata as Record<string, unknown> | undefined;
  const value = metadata?.type;
  return typeof value === "string" ? value : undefined;
}
