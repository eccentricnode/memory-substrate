export interface MarkdownLink {
  target: string;
  line: number;
}

export function normalizeMarkdownTarget(target: string): string {
  const trimmed = target.trim();
  const angleMatch = trimmed.match(/^<([^>\n]*)>(?:\s+["'][^"']*["'])?$/);
  if (angleMatch) return angleMatch[1] ?? "";
  return trimmed.replace(/\s+["'][^"']*["']\s*$/, "");
}

export function lineForOffset(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

export function isOffsetInFencedCode(content: string, offset: number): boolean {
  let inFence = false;
  let currentOffset = 0;
  for (const line of content.split("\n")) {
    const lineEndOffset = currentOffset + line.length;
    if (offset >= currentOffset && offset <= lineEndOffset) return inFence;
    if (/^ {0,3}(?:```|~~~)/.test(line)) inFence = !inFence;
    currentOffset = lineEndOffset + 1;
  }
  return inFence;
}

export function findMarkdownLinks(content: string): MarkdownLink[] {
  return [...content.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)]
    .filter((match) => !isOffsetInFencedCode(content, match.index ?? 0))
    .map((match) => ({
      target: normalizeMarkdownTarget(match[1] ?? ""),
      line: lineForOffset(content, match.index ?? 0),
    }))
    .filter((link) => link.target.length > 0);
}
