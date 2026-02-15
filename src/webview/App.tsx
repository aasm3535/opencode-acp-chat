import * as React from "react";
import { ChevronIcon, ItemArrowIcon, ModeIcon, SendIcon, StopIcon, ThoughtChevronIcon } from "./icons";
import type {
  AppState,
  AssistantMessageItem,
  ChatMetadata,
  CommandOption,
  ConnectionState,
  ModeOption,
  ModelOption,
  OutgoingMessage,
  SessionMetadataEnvelope,
  SessionUpdateEnvelope,
  ThoughtItem,
  TimelineItem,
  ToolCallItem,
  VsCodeApi,
  OpenDropdown
} from "./types";
import {
  consumeCompleteWordTokens,
  extractChunkText,
  formatToolCallLabel,
  generateId,
  inferModeKind,
  modeLabel,
  normalizeToolLocations,
  renderMarkdown,
  showChatTimestamp,
  splitModelName
} from "./utils";

const THOUGHT_TICK_MS = 250;
const THOUGHT_COLLAPSE_DELAY_MS = 240;
const PLANNING_REVEAL_DELAY_MS = 900;
const PLANNING_FADE_MS = 220;

interface AppProps {
  vscode: VsCodeApi;
}

function createAssistantItem(): AssistantMessageItem {
  return {
    id: generateId("assistant"),
    role: "assistant",
    answerBuffer: "",
    answerTokens: [],
    pendingTokenBuffer: "",
    streaming: true,
    planningState: "visible",
    thoughts: [],
    toolRows: [],
    activityBlocks: [],
    lastActivity: "none"
  };
}

function normalizeThought(raw: unknown): ThoughtItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Partial<ThoughtItem>;
  if (typeof item.id !== "string" || typeof item.content !== "string") {
    return null;
  }

  return {
    id: item.id,
    content: item.content,
    startMs: typeof item.startMs === "number" ? item.startMs : Date.now(),
    elapsedSeconds: typeof item.elapsedSeconds === "number" ? item.elapsedSeconds : 1,
    expanded: typeof item.expanded === "boolean" ? item.expanded : false
  };
}

function normalizeTool(raw: unknown): ToolCallItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Partial<ToolCallItem>;
  if (typeof item.toolCallId !== "string") {
    return null;
  }

  return {
    toolCallId: item.toolCallId,
    title: typeof item.title === "string" ? item.title : "Tool call",
    status: typeof item.status === "string" ? item.status : "pending",
    kind: typeof item.kind === "string" ? item.kind : "other",
    locations: Array.isArray(item.locations) ? item.locations.filter((location): location is string => typeof location === "string") : []
  };
}

function normalizeTimeline(raw: unknown): TimelineItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const next: TimelineItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const item = entry as Partial<TimelineItem> & Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.role !== "string") {
      continue;
    }

    if (item.role === "user") {
      next.push({
        id: item.id,
        role: "user",
        content: typeof item.content === "string" ? item.content : ""
      });
      continue;
    }

    if (item.role === "error") {
      next.push({
        id: item.id,
        role: "error",
        content: typeof item.content === "string" ? item.content : ""
      });
      continue;
    }

    if (item.role === "assistant") {
      const thoughts = Array.isArray(item.thoughts)
        ? item.thoughts.map((thought) => normalizeThought(thought)).filter((thought): thought is ThoughtItem => thought !== null)
        : [];
      const toolRows = Array.isArray(item.toolRows)
        ? item.toolRows.map((tool) => normalizeTool(tool)).filter((tool): tool is ToolCallItem => tool !== null)
        : [];
      const activityBlocks = Array.isArray(item.activityBlocks)
        ? item.activityBlocks
          .map((block) => {
            if (!block || typeof block !== "object") {
              return null;
            }
            const data = block as { type?: unknown; id?: unknown; toolCallId?: unknown };
            if (data.type === "thought" && typeof data.id === "string") {
              return { type: "thought", id: data.id } as const;
            }
            if (data.type === "tool" && typeof data.toolCallId === "string") {
              return { type: "tool", toolCallId: data.toolCallId } as const;
            }
            return null;
          })
          .filter((block): block is { type: "thought"; id: string } | { type: "tool"; toolCallId: string } => block !== null)
        : [];

      next.push({
        id: item.id,
        role: "assistant",
        answerBuffer: typeof item.answerBuffer === "string"
          ? item.answerBuffer
          : typeof item.content === "string"
            ? item.content
            : "",
        answerTokens: [],
        pendingTokenBuffer: "",
        streaming: false,
        planningState: "hidden",
        thoughts,
        toolRows,
        activityBlocks,
        lastActivity: "none"
      });
    }
  }

  return next;
}

function groupModels(models: ModelOption[], query: string): Map<string, ModelOption[]> {
  const filtered = models.filter((model) => {
    if (!query) {
      return true;
    }
    const haystack = `${model.name} ${model.modelId}`.toLowerCase();
    return haystack.includes(query);
  });

  const groups = new Map<string, ModelOption[]>();
  for (const model of filtered) {
    const split = splitModelName(model.name);
    if (!groups.has(split.provider)) {
      groups.set(split.provider, []);
    }
    groups.get(split.provider)?.push(model);
  }
  return groups;
}

function assistantHasThought(item: AssistantMessageItem): boolean {
  return item.thoughts.some((thought) => thought.content.trim().length > 0);
}

export function App({ vscode }: AppProps): React.JSX.Element {
  const saved = React.useMemo(() => vscode.getState<AppState>(), [vscode]);

  const [connectionState, setConnectionState] = React.useState<ConnectionState>("disconnected");
  const [timeline, setTimeline] = React.useState<TimelineItem[]>(() => normalizeTimeline(saved?.timeline));
  const [processing, setProcessing] = React.useState<boolean>(false);
  const [cancelRequested, setCancelRequested] = React.useState<boolean>(false);
  const [showingChats, setShowingChats] = React.useState<boolean>(false);
  const [chatsList, setChatsList] = React.useState<ChatMetadata[]>([]);
  const [commands, setCommands] = React.useState<CommandOption[]>([]);
  const [availableModes, setAvailableModes] = React.useState<ModeOption[]>([]);
  const [availableModels, setAvailableModels] = React.useState<ModelOption[]>([]);
  const [currentModeId, setCurrentModeId] = React.useState<string | null>(saved?.modeId ?? null);
  const [currentModelId, setCurrentModelId] = React.useState<string | null>(saved?.modelId ?? null);
  const [openDropdown, setOpenDropdown] = React.useState<OpenDropdown>(null);
  const [modelSearchQuery, setModelSearchQuery] = React.useState<string>("");
  const [promptText, setPromptText] = React.useState<string>("");

  const preferredModeIdRef = React.useRef<string | undefined>(saved?.modeId);
  const preferredModelIdRef = React.useRef<string | undefined>(saved?.modelId);
  const processingRef = React.useRef<boolean>(processing);
  const activeAssistantIdRef = React.useRef<string | null>(null);
  const thoughtTimerRef = React.useRef<number | null>(null);
  const planningRevealTimerRef = React.useRef<number | null>(null);
  const planningFadeTimerRef = React.useRef<number | null>(null);
  const collapseThoughtTimerRef = React.useRef<number | null>(null);

  const messagesRef = React.useRef<HTMLDivElement | null>(null);
  const promptInputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const modeDropdownRef = React.useRef<HTMLDivElement | null>(null);
  const modelDropdownRef = React.useRef<HTMLDivElement | null>(null);
  const modelSearchInputRef = React.useRef<HTMLInputElement | null>(null);

  const post = React.useCallback((payload: OutgoingMessage): void => {
    vscode.postMessage(payload);
  }, [vscode]);

  const stopThoughtTimer = React.useCallback((): void => {
    if (thoughtTimerRef.current !== null) {
      window.clearInterval(thoughtTimerRef.current);
      thoughtTimerRef.current = null;
    }
  }, []);

  const stopPlanningRevealTimer = React.useCallback((): void => {
    if (planningRevealTimerRef.current !== null) {
      window.clearTimeout(planningRevealTimerRef.current);
      planningRevealTimerRef.current = null;
    }
  }, []);

  const stopPlanningFadeTimer = React.useCallback((): void => {
    if (planningFadeTimerRef.current !== null) {
      window.clearTimeout(planningFadeTimerRef.current);
      planningFadeTimerRef.current = null;
    }
  }, []);

  const stopCollapseThoughtTimer = React.useCallback((): void => {
    if (collapseThoughtTimerRef.current !== null) {
      window.clearTimeout(collapseThoughtTimerRef.current);
      collapseThoughtTimerRef.current = null;
    }
  }, []);

  const stopAllTimers = React.useCallback((): void => {
    stopThoughtTimer();
    stopPlanningRevealTimer();
    stopPlanningFadeTimer();
    stopCollapseThoughtTimer();
  }, [stopCollapseThoughtTimer, stopPlanningFadeTimer, stopPlanningRevealTimer, stopThoughtTimer]);

  const updateActiveAssistant = React.useCallback((updater: (item: AssistantMessageItem) => AssistantMessageItem): void => {
    setTimeline((prev) => {
      const activeId = activeAssistantIdRef.current;
      if (!activeId) {
        return prev;
      }

      const index = prev.findIndex((entry) => entry.id === activeId && entry.role === "assistant");
      if (index < 0) {
        return prev;
      }

      const current = prev[index] as AssistantMessageItem;
      const nextItem = updater(current);
      if (nextItem === current) {
        return prev;
      }

      const next = [...prev];
      next[index] = nextItem;
      return next;
    });
  }, []);

  const updateCurrentThoughtElapsed = React.useCallback((): void => {
    updateActiveAssistant((assistant) => {
      if (assistant.thoughts.length === 0) {
        return assistant;
      }

      const thoughts = [...assistant.thoughts];
      const currentThought = thoughts[thoughts.length - 1];
      const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - currentThought.startMs) / 1000));
      if (elapsedSeconds === currentThought.elapsedSeconds) {
        return assistant;
      }

      thoughts[thoughts.length - 1] = { ...currentThought, elapsedSeconds };
      return { ...assistant, thoughts };
    });
  }, [updateActiveAssistant]);

  const startThoughtTimer = React.useCallback((): void => {
    stopThoughtTimer();
    updateCurrentThoughtElapsed();
    thoughtTimerRef.current = window.setInterval(() => {
      updateCurrentThoughtElapsed();
    }, THOUGHT_TICK_MS);
  }, [stopThoughtTimer, updateCurrentThoughtElapsed]);

  const fadeOutPlanning = React.useCallback((): void => {
    stopPlanningRevealTimer();
    updateActiveAssistant((assistant) => {
      if (assistant.planningState !== "visible") {
        return assistant;
      }
      return { ...assistant, planningState: "fading" };
    });

    stopPlanningFadeTimer();
    planningFadeTimerRef.current = window.setTimeout(() => {
      updateActiveAssistant((assistant) => {
        if (assistant.planningState !== "fading") {
          return assistant;
        }
        return { ...assistant, planningState: "hidden" };
      });
    }, PLANNING_FADE_MS);
  }, [stopPlanningFadeTimer, stopPlanningRevealTimer, updateActiveAssistant]);

  const schedulePlanningStatus = React.useCallback((): void => {
    stopPlanningRevealTimer();
    planningRevealTimerRef.current = window.setTimeout(() => {
      if (!processingRef.current) {
        return;
      }

      updateActiveAssistant((assistant) => {
        if (assistant.lastActivity === "thought") {
          return assistant;
        }
        if (assistant.planningState !== "hidden") {
          return assistant;
        }
        if (assistant.answerBuffer.trim().length > 0) {
          return assistant;
        }
        return { ...assistant, planningState: "visible" };
      });
    }, PLANNING_REVEAL_DELAY_MS);
  }, [stopPlanningRevealTimer, updateActiveAssistant]);

  const finalizeAssistantMessage = React.useCallback((): void => {
    stopAllTimers();
    setTimeline((prev) => {
      const activeId = activeAssistantIdRef.current;
      activeAssistantIdRef.current = null;
      if (!activeId) {
        return prev;
      }

      const index = prev.findIndex((entry) => entry.id === activeId && entry.role === "assistant");
      if (index < 0) {
        return prev;
      }

      const assistant = prev[index] as AssistantMessageItem;
      const hasThought = assistantHasThought(assistant);
      const hasToolActivity = assistant.toolRows.length > 0;

      if (!assistant.answerBuffer.trim() && !hasThought && !hasToolActivity) {
        return prev.filter((entry) => entry.id !== assistant.id);
      }

      const thoughts = assistant.thoughts.map((thought) => ({ ...thought, expanded: false }));
      const nextAssistant: AssistantMessageItem = {
        ...assistant,
        streaming: false,
        pendingTokenBuffer: "",
        planningState: "hidden",
        thoughts,
        lastActivity: "none"
      };

      const next = [...prev];
      next[index] = nextAssistant;
      return next;
    });
  }, [stopAllTimers]);

  const startPrompt = React.useCallback((): void => {
    stopAllTimers();
    setCancelRequested(false);
    setProcessing(true);

    const assistant = createAssistantItem();
    activeAssistantIdRef.current = assistant.id;
    setTimeline((prev) => [...prev, assistant]);
  }, [stopAllTimers]);

  const appendThoughtChunk = React.useCallback((chunk: string): void => {
    if (!chunk) {
      return;
    }

    fadeOutPlanning();

    updateActiveAssistant((assistant) => {
      let thoughts = assistant.thoughts;
      let activityBlocks = assistant.activityBlocks;

      if (assistant.lastActivity !== "thought") {
        const thought: ThoughtItem = {
          id: generateId("thought"),
          content: chunk,
          startMs: Date.now(),
          elapsedSeconds: 1,
          expanded: true
        };
        thoughts = [...assistant.thoughts, thought];
        activityBlocks = [...assistant.activityBlocks, { type: "thought", id: thought.id }];
      } else {
        if (assistant.thoughts.length === 0) {
          const thought: ThoughtItem = {
            id: generateId("thought"),
            content: chunk,
            startMs: Date.now(),
            elapsedSeconds: 1,
            expanded: true
          };
          thoughts = [thought];
          activityBlocks = [...assistant.activityBlocks, { type: "thought", id: thought.id }];
        } else {
          thoughts = [...assistant.thoughts];
          const last = thoughts[thoughts.length - 1];
          thoughts[thoughts.length - 1] = { ...last, content: `${last.content}${chunk}` };
        }
      }

      return {
        ...assistant,
        thoughts,
        activityBlocks,
        lastActivity: "thought"
      };
    });

    startThoughtTimer();
  }, [fadeOutPlanning, startThoughtTimer, updateActiveAssistant]);

  const appendMessageChunk = React.useCallback((chunk: string): void => {
    if (!chunk) {
      return;
    }

    fadeOutPlanning();

    let firstAnswerChunk = false;
    updateActiveAssistant((assistant) => {
      firstAnswerChunk = assistant.answerBuffer.length === 0;

      const pending = `${assistant.pendingTokenBuffer}${chunk}`;
      const consumed = consumeCompleteWordTokens(pending);
      return {
        ...assistant,
        answerBuffer: `${assistant.answerBuffer}${chunk}`,
        answerTokens: [...assistant.answerTokens, ...consumed.tokens],
        pendingTokenBuffer: consumed.remainder,
        lastActivity: "none"
      };
    });

    if (firstAnswerChunk) {
      stopCollapseThoughtTimer();
      collapseThoughtTimerRef.current = window.setTimeout(() => {
        updateActiveAssistant((assistant) => {
          const thoughts = assistant.thoughts.map((thought) => ({ ...thought, expanded: false }));
          return { ...assistant, thoughts };
        });
      }, THOUGHT_COLLAPSE_DELAY_MS);
    }
  }, [fadeOutPlanning, stopCollapseThoughtTimer, updateActiveAssistant]);

  const upsertToolCall = React.useCallback((update: SessionUpdateEnvelope): void => {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!toolCallId) {
      return;
    }

    fadeOutPlanning();

    updateActiveAssistant((assistant) => {
      if (assistant.lastActivity === "thought") {
        stopThoughtTimer();
      }

      const existing = assistant.toolRows.find((item) => item.toolCallId === toolCallId);
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

      const nextTool: ToolCallItem = {
        toolCallId,
        title,
        status,
        kind,
        locations
      };

      let toolRows = assistant.toolRows;
      let activityBlocks = assistant.activityBlocks;
      const existingIndex = assistant.toolRows.findIndex((item) => item.toolCallId === toolCallId);
      if (existingIndex >= 0) {
        toolRows = [...assistant.toolRows];
        toolRows[existingIndex] = nextTool;
      } else {
        toolRows = [...assistant.toolRows, nextTool];
        activityBlocks = [...assistant.activityBlocks, { type: "tool", toolCallId }];
      }

      return {
        ...assistant,
        toolRows,
        activityBlocks,
        lastActivity: "tool"
      };
    });

    schedulePlanningStatus();
  }, [fadeOutPlanning, schedulePlanningStatus, stopThoughtTimer, updateActiveAssistant]);

  const handleSessionUpdate = React.useCallback((update: SessionUpdateEnvelope): void => {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = extractChunkText(update as { content?: unknown; text?: unknown });
        if (typeof text === "string" && text.length > 0) {
          appendMessageChunk(text);
        }
        break;
      }
      case "agent_thought_chunk": {
        const text = extractChunkText(update as { content?: unknown; text?: unknown });
        if (typeof text === "string" && text.length > 0) {
          appendThoughtChunk(text);
        }
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        upsertToolCall(update);
        break;
      }
      case "available_commands_update": {
        setCommands((update.availableCommands as CommandOption[]) ?? []);
        break;
      }
      case "current_mode_update": {
        const modeId = String(update.currentModeId ?? "");
        if (modeId) {
          setCurrentModeId(modeId);
          preferredModeIdRef.current = modeId;
        }
        break;
      }
      case "current_model_update": {
        const modelId = String(update.currentModelId ?? "");
        if (modelId) {
          setCurrentModelId(modelId);
          preferredModelIdRef.current = modelId;
        }
        break;
      }
      default:
        break;
    }
  }, [appendMessageChunk, appendThoughtChunk, upsertToolCall]);

  const applyMetadata = React.useCallback((metadata: SessionMetadataEnvelope): void => {
    const modes = metadata.modes?.availableModes ?? [];
    const models = metadata.models?.availableModels ?? [];

    setAvailableModes(modes);
    setAvailableModels(models);

    if (modes.length > 0) {
      const desiredMode = metadata.modes?.currentModeId
        ?? preferredModeIdRef.current
        ?? currentModeId
        ?? modes[0].id;
      const nextModeId = modes.some((mode) => mode.id === desiredMode)
        ? desiredMode
        : modes[0].id;
      setCurrentModeId(nextModeId);
      preferredModeIdRef.current = nextModeId;
    } else {
      setCurrentModeId(null);
    }

    if (models.length > 0) {
      const desiredModel = metadata.models?.currentModelId
        ?? preferredModelIdRef.current
        ?? currentModelId
        ?? models[0].modelId;
      const nextModelId = models.some((model) => model.modelId === desiredModel)
        ? desiredModel
        : models[0].modelId;
      setCurrentModelId(nextModelId);
      preferredModelIdRef.current = nextModelId;
    } else {
      setCurrentModelId(null);
    }

    setCommands(metadata.commands ?? []);
  }, [currentModeId, currentModelId]);

  const requestCancel = React.useCallback((): void => {
    if (!processingRef.current || cancelRequested) {
      return;
    }
    setCancelRequested(true);
    post({ type: "cancel" });
  }, [cancelRequested, post]);

  const sendPrompt = React.useCallback((): void => {
    if (processingRef.current) {
      requestCancel();
      return;
    }

    const text = promptText.trim();
    if (!text) {
      return;
    }

    if (showingChats) {
      setShowingChats(false);
    }

    setTimeline((prev) => [...prev, { id: generateId("user"), role: "user", content: text }]);
    setPromptText("");
    post({ type: "prompt", text });
  }, [post, promptText, requestCancel, showingChats]);

  const switchChat = React.useCallback((chatId: string): void => {
    setShowingChats(false);
    stopAllTimers();
    activeAssistantIdRef.current = null;
    setTimeline([]);
    post({ type: "switchChat", chatId });
  }, [post, stopAllTimers]);

  React.useEffect(() => {
    processingRef.current = processing;
    if (!processing) {
      setCancelRequested(false);
    } else {
      setOpenDropdown(null);
    }
  }, [processing]);

  React.useEffect(() => {
    vscode.setState<AppState>({
      timeline,
      modeId: currentModeId ?? undefined,
      modelId: currentModelId ?? undefined
    });
  }, [currentModeId, currentModelId, timeline, vscode]);

  React.useEffect(() => {
    const element = messagesRef.current;
    if (!element || showingChats) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [showingChats, timeline]);

  React.useEffect(() => {
    const element = promptInputRef.current;
    if (!element) {
      return;
    }
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [promptText]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent<Record<string, unknown>>): void => {
      const payload = event.data;
      const type = typeof payload?.type === "string" ? payload.type : "";

      switch (type) {
        case "connectionState": {
          setConnectionState(String(payload.state ?? "disconnected") as ConnectionState);
          break;
        }
        case "metadata": {
          applyMetadata(payload.metadata as SessionMetadataEnvelope);
          break;
        }
        case "sessionUpdate": {
          handleSessionUpdate(payload.update as SessionUpdateEnvelope);
          break;
        }
        case "promptStart": {
          startPrompt();
          break;
        }
        case "promptEnd": {
          finalizeAssistantMessage();
          setProcessing(false);
          break;
        }
        case "chatReset": {
          stopAllTimers();
          activeAssistantIdRef.current = null;
          setTimeline([]);
          break;
        }
        case "chatListUpdated": {
          setChatsList((payload.chats as ChatMetadata[]) ?? []);
          break;
        }
        case "chatLoaded": {
          stopAllTimers();
          activeAssistantIdRef.current = null;
          setShowingChats(false);
          break;
        }
        case "chatHistoryMessage": {
          const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : null;
          if (!role) {
            break;
          }

          const content = String(payload.content ?? "");
          if (role === "assistant") {
            const assistant: AssistantMessageItem = {
              ...createAssistantItem(),
              id: generateId("assistant-history"),
              streaming: false,
              planningState: "hidden",
              answerBuffer: content,
              answerTokens: [],
              pendingTokenBuffer: "",
              lastActivity: "none"
            };
            setTimeline((prev) => [...prev, assistant]);
          } else {
            setTimeline((prev) => [...prev, { id: generateId("user-history"), role: "user", content }]);
          }
          break;
        }
        case "error": {
          finalizeAssistantMessage();
          setProcessing(false);
          setTimeline((prev) => [...prev, { id: generateId("error"), role: "error", content: String(payload.message ?? "Unknown error") }]);
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [
    applyMetadata,
    finalizeAssistantMessage,
    handleSessionUpdate,
    startPrompt,
    stopAllTimers
  ]);

  React.useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      if (!openDropdown) {
        return;
      }
      const target = event.target as Node;
      const modeNode = modeDropdownRef.current;
      const modelNode = modelDropdownRef.current;
      if (modeNode?.contains(target) || modelNode?.contains(target)) {
        return;
      }
      setOpenDropdown(null);
    };

    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpenDropdown(null);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [openDropdown]);

  React.useEffect(() => {
    if (openDropdown === "model") {
      queueMicrotask(() => {
        modelSearchInputRef.current?.focus();
      });
    }
  }, [openDropdown]);

  React.useEffect(() => {
    post({ type: "ready" });
  }, [post]);

  React.useEffect(() => {
    return () => {
      stopAllTimers();
    };
  }, [stopAllTimers]);

  const currentMode = React.useMemo((): ModeOption | null => {
    if (availableModes.length === 0) {
      return null;
    }
    if (currentModeId) {
      const found = availableModes.find((mode) => mode.id === currentModeId);
      if (found) {
        return found;
      }
    }
    return availableModes[0] ?? null;
  }, [availableModes, currentModeId]);

  const currentModel = React.useMemo((): ModelOption | null => {
    if (availableModels.length === 0) {
      return null;
    }
    if (currentModelId) {
      const found = availableModels.find((model) => model.modelId === currentModelId);
      if (found) {
        return found;
      }
    }
    return availableModels[0] ?? null;
  }, [availableModels, currentModelId]);

  const groupedModels = React.useMemo(() => {
    return groupModels(availableModels, modelSearchQuery.trim().toLowerCase());
  }, [availableModels, modelSearchQuery]);

  const modeKind = inferModeKind(currentMode);
  const modeValue = currentMode ? modeLabel(currentMode, modeKind) : "Build";
  const modelValue = currentModel ? splitModelName(currentModel.name).display : "auto";

  const onPromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendPrompt();
      return;
    }

    if (event.key === "Tab" && promptText.startsWith("/") && !promptText.includes(" ")) {
      const query = promptText.slice(1).toLowerCase();
      const match = commands.find((command) => command.name.toLowerCase().startsWith(query));
      if (match) {
        event.preventDefault();
        setPromptText(`/${match.name} `);
      }
    }
  };

  const toggleThought = (assistantId: string, thoughtId: string): void => {
    setTimeline((prev) => {
      const index = prev.findIndex((entry) => entry.id === assistantId && entry.role === "assistant");
      if (index < 0) {
        return prev;
      }

      const assistant = prev[index] as AssistantMessageItem;
      const thoughts = assistant.thoughts.map((thought) => {
        if (thought.id !== thoughtId) {
          return thought;
        }
        return { ...thought, expanded: !thought.expanded };
      });

      const nextAssistant: AssistantMessageItem = { ...assistant, thoughts };
      const next = [...prev];
      next[index] = nextAssistant;
      return next;
    });
  };

  const renderAssistantBlock = (assistant: AssistantMessageItem, block: { type: "thought"; id: string } | { type: "tool"; toolCallId: string }): React.JSX.Element | null => {
    if (block.type === "thought") {
      const thought = assistant.thoughts.find((entry) => entry.id === block.id);
      if (!thought) {
        return null;
      }
      return (
        <React.Fragment key={thought.id}>
          <button
            type="button"
            className="thought-toggle"
            aria-expanded={thought.expanded ? "true" : "false"}
            onClick={() => toggleThought(assistant.id, thought.id)}
          >
            <span className="thought-label">Thought {thought.elapsedSeconds}s</span>
            <span className="thought-chevron-wrap">
              <ThoughtChevronIcon />
            </span>
          </button>
          <div className={`thought-body${thought.expanded ? "" : " is-collapsed"}`}>
            <div className="thought-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(thought.content) }} />
          </div>
        </React.Fragment>
      );
    }

    const tool = assistant.toolRows.find((entry) => entry.toolCallId === block.toolCallId);
    if (!tool) {
      return null;
    }

    return (
      <div key={tool.toolCallId} className="tool-row">
        {formatToolCallLabel(tool)}
      </div>
    );
  };

  const isModeDisabled = processing || availableModes.length === 0;
  const isModelDisabled = processing || availableModels.length === 0;

  return (
    <div id="app">
      <div id="chatHeader" className="chat-header">
        <span
          className={`connection-state ${connectionState}`}
          title={connectionState}
          aria-label={`Connection ${connectionState}`}
        />
        <button
          id="chatsLink"
          type="button"
          className="chats-link"
          onClick={() => {
            if (showingChats) {
              setShowingChats(false);
            } else {
              setShowingChats(true);
              post({ type: "loadChatHistory" });
            }
          }}
        >
          {showingChats ? "Back to chat" : "View chats"}
        </button>
      </div>

      <main id="messages" ref={messagesRef} className="messages">
        {showingChats ? (
          chatsList.length === 0 ? (
            <div className="empty-chats"><p>No chats yet. Start a conversation!</p></div>
          ) : (
            <div className="chats-list">
              {chatsList.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  className="chat-item"
                  onClick={() => switchChat(chat.id)}
                >
                  <div className="chat-title">{chat.title}</div>
                  <div className="chat-meta">{showChatTimestamp(chat.updatedAt)}</div>
                </button>
              ))}
            </div>
          )
        ) : (
          timeline.map((entry) => {
            if (entry.role === "user") {
              return (
                <div key={entry.id} className="message user">{entry.content}</div>
              );
            }

            if (entry.role === "error") {
              return (
                <div key={entry.id} className="message error">{entry.content}</div>
              );
            }

            const assistant = entry as AssistantMessageItem;
            return (
              <div key={assistant.id} className="message assistant">
                <div
                  className={`thinking-shimmer planning-status${assistant.planningState === "visible" ? " is-visible" : ""}${assistant.planningState === "fading" ? " is-fading" : ""}${assistant.planningState === "hidden" ? " is-hidden" : ""}`}
                >
                  Planning next moves
                </div>

                {assistant.activityBlocks.map((block) => renderAssistantBlock(assistant, block))}

                <div className={`assistant-answer${assistant.streaming ? " streaming" : ""}`}>
                  {assistant.streaming ? (
                    <>
                      {assistant.answerTokens.map((token, index) => (
                        <span
                          key={`${assistant.id}-token-${index}`}
                          className="word-reveal"
                          style={{ animationDelay: `${(index % 6) * 24}ms` }}
                        >
                          {token}
                        </span>
                      ))}
                      {assistant.pendingTokenBuffer ? <span className="word-reveal">{assistant.pendingTokenBuffer}</span> : null}
                    </>
                  ) : (
                    <span dangerouslySetInnerHTML={{ __html: renderMarkdown(assistant.answerBuffer) }} />
                  )}
                </div>
              </div>
            );
          })
        )}
      </main>

      <form
        id="composer"
        className="composer"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          sendPrompt();
        }}
      >
        <div className="input-shell">
          <textarea
            id="promptInput"
            ref={promptInputRef}
            rows={1}
            value={promptText}
            readOnly={processing}
            placeholder="Ask anything, @ context, / commands"
            onChange={(event) => setPromptText(event.target.value)}
            onKeyDown={onPromptKeyDown}
          />

          <div className="input-footer">
            <div className="selector-row">
              <div
                ref={modeDropdownRef}
                className={`dropdown mode-dropdown${openDropdown === "mode" ? " open" : ""}`}
                id="modeDropdown"
              >
                <button
                  id="modeTrigger"
                  className="dropdown-trigger mode-trigger"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={openDropdown === "mode" ? "true" : "false"}
                  disabled={isModeDisabled}
                  onClick={() => {
                    setOpenDropdown((prev) => prev === "mode" ? null : "mode");
                  }}
                >
                  <span className="trigger-main">
                    <span id="modeGlyph" className="mode-glyph" aria-hidden="true">
                      <ModeIcon kind={modeKind} />
                    </span>
                    <span id="modeValue">{modeValue}</span>
                  </span>
                  <ChevronIcon />
                </button>

                <div id="modeMenu" className="dropdown-menu" role="listbox" aria-label="Mode">
                  {availableModes.map((mode) => {
                    const kind = inferModeKind(mode);
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        className={`dropdown-item${currentModeId === mode.id ? " active" : ""}`}
                        role="option"
                        aria-selected={currentModeId === mode.id ? "true" : "false"}
                        onClick={() => {
                          setCurrentModeId(mode.id);
                          preferredModeIdRef.current = mode.id;
                          setOpenDropdown(null);
                          post({ type: "setMode", modeId: mode.id });
                        }}
                      >
                        <span className="item-left">
                          <ModeIcon kind={kind} />
                          <span>{modeLabel(mode, kind)}</span>
                        </span>
                        <span className="item-right"><ItemArrowIcon /></span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div ref={modelDropdownRef} className={`dropdown model-dropdown${openDropdown === "model" ? " open" : ""}`} id="modelDropdown">
                <button
                  id="modelTrigger"
                  className="dropdown-trigger model-trigger"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={openDropdown === "model" ? "true" : "false"}
                  disabled={isModelDisabled}
                  onClick={() => {
                    setOpenDropdown((prev) => prev === "model" ? null : "model");
                  }}
                >
                  <span className="model-label">Model</span>
                  <span id="modelValue" className="model-value">{modelValue}</span>
                  <ChevronIcon />
                </button>

                <div id="modelMenu" className="dropdown-menu model-menu" role="listbox" aria-label="Model">
                  {availableModels.length === 0 ? (
                    <div className="model-empty">No models available</div>
                  ) : (
                    <>
                      <div className="model-search-wrap">
                        <input
                          ref={modelSearchInputRef}
                          type="text"
                          className="model-search"
                          placeholder="Search model"
                          value={modelSearchQuery}
                          onChange={(event) => setModelSearchQuery(event.target.value)}
                        />
                      </div>

                      {groupedModels.size === 0 ? (
                        <div className="model-empty">No matching models</div>
                      ) : (
                        Array.from(groupedModels.entries()).map(([provider, models]) => (
                          <React.Fragment key={provider}>
                            <div className="model-group-header">{provider}</div>
                            {models.map((model) => (
                              <button
                                key={model.modelId}
                                type="button"
                                className={`dropdown-item model-item${currentModelId === model.modelId ? " active" : ""}`}
                                role="option"
                                aria-selected={currentModelId === model.modelId ? "true" : "false"}
                                onClick={() => {
                                  setCurrentModelId(model.modelId);
                                  preferredModelIdRef.current = model.modelId;
                                  setOpenDropdown(null);
                                  post({ type: "setModel", modelId: model.modelId });
                                }}
                              >
                                <span className="item-left">{splitModelName(model.name).display}</span>
                                <span className="item-right"><ItemArrowIcon /></span>
                              </button>
                            ))}
                          </React.Fragment>
                        ))
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            <button
              id="sendBtn"
              className={`send-btn${processing ? " is-stop" : ""}`}
              type="submit"
              aria-label={processing ? "Stop" : "Send"}
              disabled={cancelRequested}
            >
              {processing ? <StopIcon /> : <SendIcon />}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
