import { marked } from "marked";
import type { ModeKind, ModeOption, ToolCallItem } from "./types";

export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=("[^"]*"|'[^']*')/gi, "")
    .replace(/javascript:/gi, "");
}

export function renderMarkdown(text: string): string {
  return sanitizeHtml(marked.parse(text, { breaks: true, gfm: true }) as string);
}

export function extractChunkText(update: { content?: unknown; text?: unknown }): string | null {
  if (typeof update.text === "string") {
    return update.text;
  }

  const content = update.content as { type?: unknown; text?: unknown } | string | undefined;
  if (typeof content === "string") {
    return content;
  }

  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }

  return null;
}

export function consumeCompleteWordTokens(text: string): { tokens: string[]; remainder: string } {
  const tokens = text.match(/\S+\s*/g) ?? [];
  if (tokens.length === 0) {
    return { tokens: [], remainder: text };
  }

  if (/\s$/.test(text)) {
    return { tokens, remainder: "" };
  }

  const remainder = tokens.pop() ?? "";
  return { tokens, remainder };
}

export function normalizeToolLocations(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const values: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const pathValue = typeof (entry as { path?: unknown }).path === "string"
      ? (entry as { path: string }).path
      : "";
    if (!pathValue) {
      continue;
    }

    const lineValue = typeof (entry as { line?: unknown }).line === "number"
      ? (entry as { line: number }).line
      : null;
    values.push(lineValue && lineValue > 0 ? `${pathValue}:L${lineValue}` : pathValue);
  }

  return values;
}

export function formatToolCallLabel(call: ToolCallItem): string {
  const firstLocation = call.locations[0] ?? "";
  if (call.title && call.title !== "Tool call") {
    return call.title;
  }

  const titlePrefix = call.kind[0]?.toUpperCase() ?? "T";
  return `${titlePrefix}${call.kind.slice(1)}${firstLocation ? ` ${firstLocation}` : ""}`;
}

export function inferModeKind(mode: ModeOption | null): ModeKind {
  if (!mode) {
    return "default";
  }

  const probe = `${mode.id} ${mode.name}`.toLowerCase();
  if (probe.includes("build")) {
    return "build";
  }
  if (probe.includes("plan")) {
    return "plan";
  }
  return "default";
}

export function modeLabel(mode: ModeOption, kind: ModeKind): string {
  if (kind === "build") {
    return "Build";
  }
  if (kind === "plan") {
    return "Plan";
  }
  return mode.name;
}

export function splitModelName(modelName: string): { provider: string; display: string } {
  const slashIndex = modelName.indexOf("/");
  if (slashIndex <= 0) {
    return { provider: "Other", display: modelName };
  }

  return {
    provider: modelName.slice(0, slashIndex).trim(),
    display: modelName.slice(slashIndex + 1).trim()
  };
}

export function showChatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) {
    return "Just now";
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return date.toLocaleDateString();
}

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
