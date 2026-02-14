import { marked } from "marked";
import "./main.css";

type ConnectionState = "disconnected" | "connecting" | "connected";
type ModeKind = "build" | "plan" | "default";
type OpenDropdown = "mode" | "model" | null;

interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState: <T>() => T | undefined;
  setState: <T>(state: T) => void;
}

interface SessionUpdateEnvelope {
  sessionUpdate: string;
  [key: string]: unknown;
}

interface AppState {
  history: string;
  modeId?: string;
  modelId?: string;
}

interface ModeOption {
  id: string;
  name: string;
}

interface ModelOption {
  modelId: string;
  name: string;
}

interface ToolCallItem {
  toolCallId: string;
  title: string;
  status: string;
  kind: string;
  locations: string[];
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById("messages") as HTMLDivElement;
const promptInput = document.getElementById("promptInput") as HTMLTextAreaElement;
const composerEl = document.getElementById("composer") as HTMLFormElement;
const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
const chatsLink = document.getElementById("chatsLink") as HTMLSpanElement;

interface ChatMetadata {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
}

let chatsList: ChatMetadata[] = [];
let showingChats = false;

const modeDropdown = document.getElementById("modeDropdown") as HTMLDivElement;
const modeTrigger = document.getElementById("modeTrigger") as HTMLButtonElement;
const modeMenu = document.getElementById("modeMenu") as HTMLDivElement;
const modeGlyph = document.getElementById("modeGlyph") as HTMLSpanElement;
const modeValue = document.getElementById("modeValue") as HTMLSpanElement;

const modelDropdown = document.getElementById("modelDropdown") as HTMLDivElement;
const modelTrigger = document.getElementById("modelTrigger") as HTMLButtonElement;
const modelMenu = document.getElementById("modelMenu") as HTMLDivElement;
const modelValue = document.getElementById("modelValue") as HTMLSpanElement;

let connectionState: ConnectionState = "disconnected";
let assistantBuffer = "";
let assistantMessageEl: HTMLDivElement | null = null;
let assistantAnswerEl: HTMLDivElement | null = null;
let assistantPlanningEl: HTMLDivElement | null = null;
let assistantThoughtLabelEl: HTMLSpanElement | null = null;
let assistantThoughtBodyEl: HTMLDivElement | null = null;
let assistantThoughtContentEl: HTMLDivElement | null = null;
const assistantToolCalls = new Map<string, ToolCallItem>();
const assistantToolRows = new Map<string, HTMLDivElement>();
let assistantPendingTokenBuffer = "";
let assistantThoughtBuffer = "";
let assistantThoughtStartMs = 0;
let thoughtTimerId: number | null = null;
let thoughtRevealTimerId: number | null = null;
let planningRevealTimerId: number | null = null;
let assistantWordRevealIndex = 0;
let assistantLastActivity: "none" | "thought" | "tool" = "none";
let processing = false;
let cancelRequested = false;
let commands: Array<{ name: string; description?: string }> = [];

let availableModes: ModeOption[] = [];
let availableModels: ModelOption[] = [];
let currentModeId: string | null = null;
let currentModelId: string | null = null;
let preferredModeId: string | undefined;
let preferredModelId: string | undefined;
let modelSearchQuery = "";

let openDropdown: OpenDropdown = null;

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+=("[^"]*"|'[^']*')/gi, "")
    .replace(/javascript:/gi, "");
}

function renderMarkdown(text: string): string {
  return sanitizeHtml(marked.parse(text, { breaks: true, gfm: true }) as string);
}

function sendIcon(): string {
  return `<svg class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V3"></path><path d="m5 10 7-7 7 7"></path></svg>`;
}

function stopIcon(): string {
  return `<svg class="send-icon stop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>`;
}

function renderSendButton(): void {
  sendBtn.innerHTML = processing ? stopIcon() : sendIcon();
  sendBtn.setAttribute("aria-label", processing ? "Stop" : "Send");
  sendBtn.classList.toggle("is-stop", processing);
  sendBtn.disabled = cancelRequested;
}

function thoughtChevronIcon(): string {
  return `<svg class="thought-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>`;
}

function formatThoughtElapsed(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `Thought ${seconds}s`;
}

function updateThoughtLabel(): void {
  if (!assistantThoughtLabelEl || !assistantThoughtStartMs) {
    return;
  }
  assistantThoughtLabelEl.textContent = formatThoughtElapsed(Date.now() - assistantThoughtStartMs);
}

function stopThoughtTimer(): void {
  if (thoughtTimerId !== null) {
    window.clearInterval(thoughtTimerId);
    thoughtTimerId = null;
  }
}

function stopThoughtRevealTimer(): void {
  if (thoughtRevealTimerId !== null) {
    window.clearTimeout(thoughtRevealTimerId);
    thoughtRevealTimerId = null;
  }
}

function stopPlanningRevealTimer(): void {
  if (planningRevealTimerId !== null) {
    window.clearTimeout(planningRevealTimerId);
    planningRevealTimerId = null;
  }
}

function startThoughtTimer(): void {
  stopThoughtTimer();
  updateThoughtLabel();
  thoughtTimerId = window.setInterval(() => {
    updateThoughtLabel();
  }, 250);
}

function showPlanningStatus(): void {
  const bubble = ensureAssistantMessage();
  if (assistantPlanningEl) {
    assistantPlanningEl.classList.remove("done");
    return;
  }

  const planning = document.createElement("div");
  planning.className = "thinking-shimmer planning-status";
  planning.textContent = "Planning next moves";

  if (assistantAnswerEl) {
    bubble.insertBefore(planning, assistantAnswerEl);
  } else {
    bubble.appendChild(planning);
  }
  assistantPlanningEl = planning;
}

function schedulePlanningStatus(delay = 900): void {
  stopPlanningRevealTimer();
  planningRevealTimerId = window.setTimeout(() => {
    if (!processing || assistantLastActivity === "thought") {
      return;
    }
    if (assistantPlanningEl || assistantBuffer.trim()) {
      return;
    }
    showPlanningStatus();
  }, delay);
}

function setThoughtExpanded(messageEl: HTMLDivElement, expanded: boolean): void {
  const toggle = messageEl.querySelector(".thought-toggle") as HTMLButtonElement | null;
  const body = messageEl.querySelector(".thought-body") as HTMLDivElement | null;
  if (!toggle || !body) {
    return;
  }

  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  body.classList.toggle("is-collapsed", !expanded);
}

function normalizeToolLocations(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const values: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const path = typeof (entry as { path?: unknown }).path === "string"
      ? (entry as { path: string }).path
      : "";
    if (!path) {
      continue;
    }

    const line = typeof (entry as { line?: unknown }).line === "number"
      ? (entry as { line: number }).line
      : null;
    values.push(line && line > 0 ? `${path}:L${line}` : path);
  }

  return values;
}

function formatToolCallLabel(call: ToolCallItem): string {
  const firstLocation = call.locations[0] ?? "";
  if (call.title && call.title !== "Tool call") {
    return call.title;
  }
  return `${call.kind[0]?.toUpperCase() ?? "T"}${call.kind.slice(1)}${firstLocation ? ` ${firstLocation}` : ""}`;
}

function ensureToolRow(call: ToolCallItem): HTMLDivElement {
  const label = formatToolCallLabel(call);
  const existingRow = assistantToolRows.get(call.toolCallId);
  if (existingRow) {
    existingRow.textContent = label;
    return existingRow;
  }

  const bubble = ensureAssistantMessage();
  const row = document.createElement("div");
  row.className = "tool-row";
  row.textContent = label;

  if (assistantAnswerEl) {
    bubble.insertBefore(row, assistantAnswerEl);
  } else {
    bubble.appendChild(row);
  }

  assistantToolRows.set(call.toolCallId, row);
  return row;
}

function consumeCompleteWordTokens(text: string): { tokens: string[]; remainder: string } {
  const tokens = text.match(/\S+\s*/g) ?? [];
  if (!tokens.length) {
    return { tokens: [], remainder: text };
  }

  if (/\s$/.test(text)) {
    return { tokens, remainder: "" };
  }

  const remainder = tokens.pop() ?? "";
  return { tokens, remainder };
}

function extractChunkText(update: { content?: unknown; text?: unknown }): string | null {
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

function inferModeKind(mode: ModeOption | null): ModeKind {
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

function modeIcon(kind: ModeKind): string {
  if (kind === "build") {
    return `<svg class="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12c0-2.2 1.8-4 4-4 3 0 4.5 8 8 8 2.2 0 4-1.8 4-4s-1.8-4-4-4c-3.5 0-5 8-8 8-2.2 0-4-1.8-4-4Z"></path></svg>`;
  }
  if (kind === "plan") {
    return `<svg class="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11"></path><path d="M9 12h11"></path><path d="M9 18h11"></path><path d="m5 6-1 1-1-1"></path><path d="m5 12-1 1-1-1"></path><path d="m5 18-1 1-1-1"></path></svg>`;
  }
  return `<svg class="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.7 3.5L17 8.2l-3.5 1.7L12 13.4l-1.5-3.5L7 8.2l3.5-1.7L12 3Z"></path></svg>`;
}

function modeLabel(mode: ModeOption, kind: ModeKind): string {
  if (kind === "build") {
    return "Build";
  }
  if (kind === "plan") {
    return "Plan";
  }
  return mode.name;
}

function setConnectionState(state: ConnectionState): void {
  connectionState = state;
}

function refreshInteractivity(): void {
  promptInput.readOnly = processing;
  modeTrigger.disabled = processing || availableModes.length === 0;
  modelTrigger.disabled = processing || availableModels.length === 0;
  renderSendButton();

  if (processing) {
    closeDropdown();
  }
}

function setProcessing(next: boolean): void {
  processing = next;
  if (!next) {
    cancelRequested = false;
  }
  refreshInteractivity();
}

function requestCancel(): void {
  if (!processing || cancelRequested) {
    return;
  }
  cancelRequested = true;
  renderSendButton();
  vscode.postMessage({ type: "cancel" });
}

function autoResizeTextarea(): void {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 240)}px`;
}

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendBubble(role: "user" | "assistant" | "error", content: string, isHtml = false): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  if (isHtml) {
    el.innerHTML = sanitizeHtml(content);
  } else {
    el.textContent = content;
  }
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function fadeOutPlanning(): void {
  stopPlanningRevealTimer();
  if (!assistantPlanningEl || assistantPlanningEl.classList.contains("done")) {
    return;
  }

  assistantPlanningEl.classList.add("done");
  window.setTimeout(() => {
    assistantPlanningEl?.remove();
    assistantPlanningEl = null;
  }, 220);
}

function ensureAssistantMessage(): HTMLDivElement {
  if (assistantMessageEl) {
    return assistantMessageEl;
  }

  const el = document.createElement("div");
  el.className = "message assistant";

  const planning = document.createElement("div");
  planning.className = "thinking-shimmer planning-status";
  planning.textContent = "Planning next moves";

  const answer = document.createElement("div");
  answer.className = "assistant-answer streaming";

  el.appendChild(planning);
  el.appendChild(answer);

  messagesEl.appendChild(el);
  assistantMessageEl = el;
  assistantPlanningEl = planning;
  assistantAnswerEl = answer;
  scrollToBottom();
  return el;
}

function upsertToolCall(update: SessionUpdateEnvelope): void {
  const toolCallId = typeof update.toolCallId === "string"
    ? update.toolCallId
    : "";
  if (!toolCallId) {
    return;
  }

  const existing = assistantToolCalls.get(toolCallId);
  const title = typeof update.title === "string" && update.title.trim()
    ? update.title.trim()
    : existing?.title ?? "Tool call";
  const status = typeof update.status === "string" && update.status.trim()
    ? update.status
    : existing?.status ?? "pending";
  const kind = typeof update.kind === "string" && update.kind.trim()
    ? update.kind
    : existing?.kind ?? "other";
  const locations = Array.isArray(update.locations)
    ? normalizeToolLocations(update.locations)
    : existing?.locations ?? [];

  assistantToolCalls.set(toolCallId, {
    toolCallId,
    title,
    status,
    kind,
    locations
  });

  if (assistantLastActivity === "thought") {
    stopThoughtTimer();
    updateThoughtLabel();
  }

  assistantLastActivity = "tool";
  fadeOutPlanning();
  ensureToolRow(assistantToolCalls.get(toolCallId)!);
  schedulePlanningStatus();
  scrollToBottom();
}

function ensureThoughtSection(): void {
  const bubble = ensureAssistantMessage();
  if (assistantThoughtBodyEl && assistantThoughtLabelEl && assistantThoughtContentEl) {
    return;
  }

  const thoughtToggle = document.createElement("button");
  thoughtToggle.type = "button";
  thoughtToggle.className = "thought-toggle";
  thoughtToggle.setAttribute("aria-expanded", "true");

  const thoughtLabel = document.createElement("span");
  thoughtLabel.className = "thought-label";
  thoughtToggle.appendChild(thoughtLabel);

  const chevronWrap = document.createElement("span");
  chevronWrap.className = "thought-chevron-wrap";
  chevronWrap.innerHTML = thoughtChevronIcon();
  thoughtToggle.appendChild(chevronWrap);

  const thoughtBody = document.createElement("div");
  thoughtBody.className = "thought-body";
  const thoughtContent = document.createElement("div");
  thoughtContent.className = "thought-content";
  thoughtBody.appendChild(thoughtContent);

  if (assistantAnswerEl) {
    bubble.insertBefore(thoughtToggle, assistantAnswerEl);
    bubble.insertBefore(thoughtBody, assistantAnswerEl);
  } else {
    bubble.appendChild(thoughtToggle);
    bubble.appendChild(thoughtBody);
  }

  assistantThoughtLabelEl = thoughtLabel;
  assistantThoughtBodyEl = thoughtBody;
  assistantThoughtContentEl = thoughtContent;
  assistantThoughtStartMs = Date.now();
  startThoughtTimer();
}

function appendAssistantThoughtChunk(chunk: string): void {
  if (!chunk) {
    return;
  }

  stopThoughtRevealTimer();
  fadeOutPlanning();

  if (assistantLastActivity !== "thought") {
    stopThoughtTimer();
    updateThoughtLabel();
    assistantThoughtLabelEl = null;
    assistantThoughtBodyEl = null;
    assistantThoughtContentEl = null;
    assistantThoughtBuffer = "";
  }

  ensureThoughtSection();

  assistantThoughtBuffer += chunk;

  if (!assistantThoughtContentEl) {
    return;
  }

  assistantThoughtContentEl.innerHTML = renderMarkdown(assistantThoughtBuffer);
  assistantLastActivity = "thought";

  scrollToBottom();
}

function appendAssistantChunk(chunk: string): void {
  if (!chunk) {
    return;
  }

  stopThoughtRevealTimer();
  const firstAnswerChunk = assistantBuffer.length === 0;
  assistantBuffer += chunk;
  ensureAssistantMessage();
  fadeOutPlanning();
  assistantLastActivity = "none";

  if (assistantMessageEl && assistantThoughtBodyEl && firstAnswerChunk) {
    const messageEl = assistantMessageEl;
    window.setTimeout(() => {
      if (messageEl.isConnected) {
        const thoughtBodies = Array.from(messageEl.querySelectorAll(".thought-body")) as HTMLDivElement[];
        for (const body of thoughtBodies) {
          body.classList.add("is-collapsed");
        }
        const thoughtToggles = Array.from(messageEl.querySelectorAll(".thought-toggle")) as HTMLButtonElement[];
        for (const toggle of thoughtToggles) {
          toggle.setAttribute("aria-expanded", "false");
        }
      }
    }, 240);
  }

  assistantPendingTokenBuffer += chunk;
  const { tokens, remainder } = consumeCompleteWordTokens(assistantPendingTokenBuffer);
  assistantPendingTokenBuffer = remainder;

  if (!assistantAnswerEl) {
    return;
  }

  for (const token of tokens) {
    const word = document.createElement("span");
    word.className = "word-reveal";
    word.style.animationDelay = `${(assistantWordRevealIndex % 6) * 24}ms`;
    assistantWordRevealIndex += 1;
    word.textContent = token;
    assistantAnswerEl.appendChild(word);
  }

  scrollToBottom();
}

function finalizeAssistantMessage(): void {
  stopThoughtRevealTimer();
  stopThoughtTimer();
  fadeOutPlanning();

  if (!assistantMessageEl) {
    assistantBuffer = "";
    assistantPendingTokenBuffer = "";
    assistantThoughtBuffer = "";
    assistantWordRevealIndex = 0;
    assistantToolCalls.clear();
    assistantLastActivity = "none";
    return;
  }

  if (assistantPendingTokenBuffer && assistantAnswerEl) {
    const tail = document.createElement("span");
    tail.className = "word-reveal";
    tail.textContent = assistantPendingTokenBuffer;
    assistantAnswerEl.appendChild(tail);
  }
  assistantPendingTokenBuffer = "";

  if (assistantThoughtBuffer && assistantThoughtContentEl) {
    assistantThoughtContentEl.innerHTML = renderMarkdown(assistantThoughtBuffer);
  }
  updateThoughtLabel();

  const hasThought = Boolean(assistantThoughtBuffer.trim());
  const hasToolActivity = assistantToolRows.size > 0;

  if (!assistantBuffer.trim()) {
    if (!hasThought && !hasToolActivity) {
      assistantMessageEl.remove();
    }

    assistantMessageEl = null;
    assistantAnswerEl = null;
    assistantPlanningEl = null;
    assistantThoughtLabelEl = null;
    assistantThoughtBodyEl = null;
    assistantThoughtContentEl = null;
    assistantToolRows.clear();
    assistantThoughtStartMs = 0;
    assistantWordRevealIndex = 0;
    assistantThoughtBuffer = "";
    assistantToolCalls.clear();
    assistantLastActivity = "none";
    return;
  }

  if (assistantThoughtBodyEl) {
    assistantThoughtBodyEl.classList.add("is-collapsed");
  }

  if (assistantAnswerEl) {
    assistantAnswerEl.classList.remove("streaming");
    assistantAnswerEl.innerHTML = renderMarkdown(assistantBuffer);
  }

  assistantBuffer = "";
  assistantMessageEl = null;
  assistantAnswerEl = null;
  assistantPlanningEl = null;
  assistantThoughtLabelEl = null;
  assistantThoughtBodyEl = null;
  assistantThoughtContentEl = null;
  assistantToolRows.clear();
  assistantThoughtStartMs = 0;
  assistantWordRevealIndex = 0;
  assistantThoughtBuffer = "";
  assistantToolCalls.clear();
  assistantLastActivity = "none";
  scrollToBottom();
}

function resetChat(): void {
  stopThoughtTimer();
  stopThoughtRevealTimer();
  stopPlanningRevealTimer();
  messagesEl.innerHTML = "";
  assistantBuffer = "";
  assistantMessageEl = null;
  assistantAnswerEl = null;
  assistantPlanningEl = null;
  assistantThoughtLabelEl = null;
  assistantThoughtBodyEl = null;
  assistantThoughtContentEl = null;
  assistantToolRows.clear();
  assistantPendingTokenBuffer = "";
  assistantThoughtBuffer = "";
  assistantThoughtStartMs = 0;
  assistantWordRevealIndex = 0;
  assistantToolCalls.clear();
  assistantLastActivity = "none";
}

function showChatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return date.toLocaleDateString();
}

function renderChatsList(): void {
  resetChat();
  
  if (chatsList.length === 0) {
    messagesEl.innerHTML = `<div class="empty-chats"><p>No chats yet. Start a conversation!</p></div>`;
    return;
  }
  
  const container = document.createElement("div");
  container.className = "chats-list";
  
  for (const chat of chatsList) {
    const chatEl = document.createElement("div");
    chatEl.className = "chat-item";
    chatEl.dataset.chatId = chat.id;
    
    const title = document.createElement("div");
    title.className = "chat-title";
    title.textContent = chat.title;
    
    const meta = document.createElement("div");
    meta.className = "chat-meta";
    meta.textContent = showChatTimestamp(chat.updatedAt);
    
    chatEl.appendChild(title);
    chatEl.appendChild(meta);
    
    chatEl.addEventListener("click", () => {
      vscode.postMessage({ type: "switchChat", chatId: chat.id });
    });
    
    container.appendChild(chatEl);
  }
  
  messagesEl.appendChild(container);
  chatsLink.textContent = "Back to chat";
}

function appendHistoryMessage(role: "user" | "assistant", content: string, timestamp: number): void {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.textContent = content;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function sendPrompt(): void {
  if (processing) {
    requestCancel();
    return;
  }

  const text = promptInput.value.trim();
  if (!text) {
    return;
  }

  appendBubble("user", text);
  promptInput.value = "";
  autoResizeTextarea();

  vscode.postMessage({
    type: "prompt",
    text
  });
}

function currentMode(): ModeOption | null {
  if (!availableModes.length) {
    return null;
  }

  if (currentModeId) {
    const found = availableModes.find((item) => item.id === currentModeId);
    if (found) {
      return found;
    }
  }

  return availableModes[0] ?? null;
}

function currentModel(): ModelOption | null {
  if (!availableModels.length) {
    return null;
  }

  if (currentModelId) {
    const found = availableModels.find((item) => item.modelId === currentModelId);
    if (found) {
      return found;
    }
  }

  return availableModels[0] ?? null;
}

function renderModeTrigger(): void {
  const mode = currentMode();
  if (!mode) {
    modeValue.textContent = "Build";
    modeGlyph.innerHTML = modeIcon("build");
    modeDropdown.classList.add("hidden");
    return;
  }

  const kind = inferModeKind(mode);
  modeGlyph.innerHTML = modeIcon(kind);
  modeValue.textContent = modeLabel(mode, kind);
  modeDropdown.classList.remove("hidden");
}

function renderModeMenu(): void {
  modeMenu.innerHTML = "";

  if (!availableModes.length) {
    return;
  }

  for (const mode of availableModes) {
    const kind = inferModeKind(mode);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dropdown-item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", currentModeId === mode.id ? "true" : "false");

    if (currentModeId === mode.id) {
      item.classList.add("active");
    }

    const left = document.createElement("span");
    left.className = "item-left";
    left.innerHTML = `${modeIcon(kind)}<span>${modeLabel(mode, kind)}</span>`;

    const right = document.createElement("span");
    right.className = "item-right";
    right.innerHTML = `<svg class="item-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>`;

    item.appendChild(left);
    item.appendChild(right);

    item.addEventListener("click", () => {
      currentModeId = mode.id;
      preferredModeId = mode.id;
      renderModeTrigger();
      renderModeMenu();
      closeDropdown();
      vscode.postMessage({ type: "setMode", modeId: mode.id });
    });

    modeMenu.appendChild(item);
  }
}

function renderModelTrigger(): void {
  const model = currentModel();
  if (!model) {
    modelValue.textContent = "auto";
    return;
  }
  // Show only model name without provider prefix
  const slashIdx = model.name.indexOf("/");
  modelValue.textContent = slashIdx > 0 ? model.name.slice(slashIdx + 1).trim() : model.name;
}

function renderModelMenu(): void {
  modelMenu.innerHTML = "";

  if (availableModels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = "No models available";
    modelMenu.appendChild(empty);
    return;
  }

  // Group models by provider (split on "/" — e.g. "Anthropic/Claude Sonnet 4")
  const groups = new Map<string, typeof availableModels>();
  for (const model of availableModels) {
    const slashIdx = model.name.indexOf("/");
    const provider = slashIdx > 0 ? model.name.slice(0, slashIdx).trim() : "Other";
    if (!groups.has(provider)) {
      groups.set(provider, []);
    }
    groups.get(provider)!.push(model);
  }

  for (const [provider, models] of groups) {
    // Provider header
    const header = document.createElement("div");
    header.className = "model-group-header";
    header.textContent = provider;
    modelMenu.appendChild(header);

    for (const model of models) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "dropdown-item model-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", currentModelId === model.modelId ? "true" : "false");

      if (currentModelId === model.modelId) {
        item.classList.add("active");
      }

      // Show only the model name part (after provider prefix)
      const slashIdx = model.name.indexOf("/");
      const displayName = slashIdx > 0 ? model.name.slice(slashIdx + 1).trim() : model.name;

      const left = document.createElement("span");
      left.className = "item-left";
      left.textContent = displayName;

      const right = document.createElement("span");
      right.className = "item-right";
      right.innerHTML = `<svg class="item-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>`;

      item.appendChild(left);
      item.appendChild(right);

      item.addEventListener("click", () => {
        currentModelId = model.modelId;
        preferredModelId = model.modelId;
        renderModelTrigger();
        renderModelMenu();
        closeDropdown();
        vscode.postMessage({ type: "setModel", modelId: model.modelId });
      });

      modelMenu.appendChild(item);
    }
  }
}

function openDropdownMenu(kind: Exclude<OpenDropdown, null>): void {
  openDropdown = kind;
  modeDropdown.classList.toggle("open", kind === "mode");
  modelDropdown.classList.toggle("open", kind === "model");
  modeTrigger.setAttribute("aria-expanded", kind === "mode" ? "true" : "false");
  modelTrigger.setAttribute("aria-expanded", kind === "model" ? "true" : "false");

  if (kind === "model") {
    queueMicrotask(() => {
      const input = modelMenu.querySelector(".model-search") as HTMLInputElement | null;
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    });
  }
}

function closeDropdown(): void {
  openDropdown = null;
  modeDropdown.classList.remove("open");
  modelDropdown.classList.remove("open");
  modeTrigger.setAttribute("aria-expanded", "false");
  modelTrigger.setAttribute("aria-expanded", "false");
}

function toggleDropdown(kind: Exclude<OpenDropdown, null>): void {
  if (openDropdown === kind) {
    closeDropdown();
    return;
  }

  if (kind === "mode") {
    renderModeMenu();
  } else {
    renderModelMenu();
  }

  openDropdownMenu(kind);
}

function selectCurrentFromMetadata(metadata: {
  modes?: { availableModes?: Array<{ id: string; name: string }>; currentModeId?: string };
  models?: { availableModels?: Array<{ modelId: string; name: string }>; currentModelId?: string };
  commands?: Array<{ name: string; description?: string }>;
}): void {
  availableModes = metadata.modes?.availableModes ?? [];
  availableModels = metadata.models?.availableModels ?? [];

  if (availableModes.length) {
    const desiredMode = metadata.modes?.currentModeId ?? preferredModeId ?? currentModeId ?? availableModes[0].id;
    currentModeId = availableModes.some((mode) => mode.id === desiredMode)
      ? desiredMode
      : availableModes[0].id;
  } else {
    currentModeId = null;
  }

  if (availableModels.length) {
    const desiredModel = metadata.models?.currentModelId ?? preferredModelId ?? currentModelId ?? availableModels[0].modelId;
    currentModelId = availableModels.some((model) => model.modelId === desiredModel)
      ? desiredModel
      : availableModels[0].modelId;
  } else {
    currentModelId = null;
  }

  commands = metadata.commands ?? commands;

  renderModeTrigger();
  renderModeMenu();
  renderModelTrigger();
  renderModelMenu();
  refreshInteractivity();
}

function handleSessionUpdate(update: SessionUpdateEnvelope): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = extractChunkText(update as { content?: unknown; text?: unknown });
      if (typeof text === "string" && text.length > 0) {
        appendAssistantChunk(text);
      }
      break;
    }
    case "agent_thought_chunk": {
      const text = extractChunkText(update as { content?: unknown; text?: unknown });
      if (typeof text === "string" && text.length > 0) {
        appendAssistantThoughtChunk(text);
      }
      break;
    }
    case "tool_call": {
      upsertToolCall(update);
      break;
    }
    case "tool_call_update": {
      upsertToolCall(update);
      break;
    }
    case "available_commands_update": {
      commands = (update.availableCommands as Array<{ name: string; description?: string }>) ?? [];
      break;
    }
    case "current_mode_update": {
      const modeId = String(update.currentModeId ?? "");
      if (modeId && availableModes.some((mode) => mode.id === modeId)) {
        currentModeId = modeId;
        preferredModeId = modeId;
        renderModeTrigger();
        renderModeMenu();
      }
      break;
    }
    default:
      break;
  }
}

window.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
  const message = event.data;
  const type = message.type;

  switch (type) {
    case "connectionState": {
      setConnectionState(String(message.state ?? "disconnected") as ConnectionState);
      break;
    }
    case "metadata": {
      selectCurrentFromMetadata(message.metadata as {
        modes?: { availableModes?: Array<{ id: string; name: string }>; currentModeId?: string };
        models?: { availableModels?: Array<{ modelId: string; name: string }>; currentModelId?: string };
        commands?: Array<{ name: string; description?: string }>;
      });
      break;
    }
    case "sessionUpdate": {
      handleSessionUpdate(message.update as SessionUpdateEnvelope);
      break;
    }
    case "promptStart": {
      stopThoughtTimer();
      stopThoughtRevealTimer();
      stopPlanningRevealTimer();
      cancelRequested = false;
      assistantBuffer = "";
      assistantPendingTokenBuffer = "";
      assistantThoughtBuffer = "";
      assistantToolCalls.clear();
      assistantToolRows.clear();
      assistantLastActivity = "none";
      assistantWordRevealIndex = 0;
      setProcessing(true);
      ensureAssistantMessage();
      break;
    }
    case "promptEnd": {
      finalizeAssistantMessage();
      setProcessing(false);
      break;
    }
    case "chatReset": {
      resetChat();
      break;
    }
    case "chatListUpdated": {
      chatsList = message.chats as ChatMetadata[];
      break;
    }
    case "chatLoaded": {
      if (showingChats) {
        showingChats = false;
        resetChat();
      }
      chatsLink.textContent = "View chats";
      break;
    }
    case "chatHistoryMessage": {
      appendHistoryMessage(
        message.role as "user" | "assistant",
        String(message.content),
        Number(message.timestamp)
      );
      break;
    }
    case "error": {
      stopThoughtRevealTimer();
      stopThoughtTimer();
      stopPlanningRevealTimer();
      setProcessing(false);
      appendBubble("error", String(message.message ?? "Unknown error"));
      break;
    }
    case "connected":
    default:
      break;
  }

  vscode.setState<AppState>({
    history: messagesEl.innerHTML,
    modeId: currentModeId ?? undefined,
    modelId: currentModelId ?? undefined
  });
});

modeTrigger.addEventListener("click", () => {
  if (!modeTrigger.disabled) {
    toggleDropdown("mode");
  }
});

modelTrigger.addEventListener("click", () => {
  if (!modelTrigger.disabled) {
    toggleDropdown("model");
  }
});

document.addEventListener("mousedown", (event) => {
  const target = event.target as Node;
  if (!modeDropdown.contains(target) && !modelDropdown.contains(target)) {
    closeDropdown();
  }
});

messagesEl.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const thoughtToggle = target.closest(".thought-toggle") as HTMLButtonElement | null;
  if (!thoughtToggle) {
    return;
  }

  const message = thoughtToggle.closest(".message.assistant") as HTMLDivElement | null;
  if (!message) {
    return;
  }

  const expanded = thoughtToggle.getAttribute("aria-expanded") === "true";
  setThoughtExpanded(message, !expanded);
});

chatsLink.addEventListener("click", () => {
  if (showingChats) {
    showingChats = false;
    resetChat();
    chatsLink.textContent = "View chats";
  } else {
    showingChats = true;
    vscode.postMessage({ type: "loadChatHistory" });
    renderChatsList();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDropdown();
  }
});

composerEl.addEventListener("submit", (event) => {
  event.preventDefault();
  sendPrompt();
});

promptInput.addEventListener("input", () => {
  autoResizeTextarea();
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendPrompt();
    return;
  }

  if (event.key === "Tab" && promptInput.value.startsWith("/") && !promptInput.value.includes(" ")) {
    const query = promptInput.value.slice(1).toLowerCase();
    const match = commands.find((command) => command.name.toLowerCase().startsWith(query));
    if (match) {
      event.preventDefault();
      promptInput.value = `/${match.name} `;
      autoResizeTextarea();
    }
  }
});

const saved = vscode.getState<AppState>();
if (saved?.history) {
  messagesEl.innerHTML = saved.history;
}
preferredModeId = saved?.modeId;
preferredModelId = saved?.modelId;

promptInput.placeholder = "Ask anything, @ context, / commands";
autoResizeTextarea();
setConnectionState("disconnected");
renderModeTrigger();
renderModelTrigger();
refreshInteractivity();
vscode.postMessage({ type: "ready" });
