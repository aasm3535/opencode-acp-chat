export type ConnectionState = "disconnected" | "connecting" | "connected";
export type ModeKind = "build" | "plan" | "default";
export type OpenDropdown = "mode" | "model" | null;

export interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState: <T>() => T | undefined;
  setState: <T>(state: T) => void;
}

export interface ModeOption {
  id: string;
  name: string;
}

export interface ModelOption {
  modelId: string;
  name: string;
}

export interface CommandOption {
  name: string;
  description?: string;
}

export interface ChatMetadata {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
}

export interface ToolCallItem {
  toolCallId: string;
  title: string;
  status: string;
  kind: string;
  locations: string[];
}

export interface ThoughtItem {
  id: string;
  content: string;
  startMs: number;
  elapsedSeconds: number;
  expanded: boolean;
}

export type PlanningState = "visible" | "fading" | "hidden";
export type AssistantActivity = "none" | "thought" | "tool";

export interface UserMessageItem {
  id: string;
  role: "user";
  content: string;
}

export interface ErrorMessageItem {
  id: string;
  role: "error";
  content: string;
}

export interface AssistantMessageItem {
  id: string;
  role: "assistant";
  answerBuffer: string;
  answerTokens: string[];
  pendingTokenBuffer: string;
  streaming: boolean;
  planningState: PlanningState;
  thoughts: ThoughtItem[];
  toolRows: ToolCallItem[];
  activityBlocks: Array<{ type: "thought"; id: string } | { type: "tool"; toolCallId: string }>;
  lastActivity: AssistantActivity;
}

export type TimelineItem = UserMessageItem | ErrorMessageItem | AssistantMessageItem;

export interface AppState {
  timeline: TimelineItem[];
  modeId?: string;
  modelId?: string;
}

export interface SessionUpdateEnvelope {
  sessionUpdate: string;
  [key: string]: unknown;
}

export type OutgoingMessage =
  | { type: "ready" }
  | { type: "prompt"; text: string }
  | { type: "cancel" }
  | { type: "setMode"; modeId: string }
  | { type: "setModel"; modelId: string }
  | { type: "loadChatHistory" }
  | { type: "clearAllChats" }
  | { type: "switchChat"; chatId: string };

export interface SessionMetadataEnvelope {
  modes?: {
    availableModes?: ModeOption[];
    currentModeId?: string;
  };
  models?: {
    availableModels?: ModelOption[];
    currentModelId?: string;
  };
  commands?: CommandOption[];
}
