import * as vscode from "vscode";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient } from "../acp/AcpClient";
import { SessionStorage } from "../storage/SessionStorage";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

type WebviewIncomingMessage =
  | { type: "ready" }
  | { type: "connect" }
  | { type: "newSession" }
  | { type: "prompt"; text: string; includeSelection?: boolean }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "setMode"; modeId: string }
  | { type: "setModel"; modelId: string }
  | { type: "showLogs" }
  | { type: "loadChatHistory" }
  | { type: "switchChat"; chatId: string }
  | { type: "deleteChat"; chatId: string }
  | { type: "clearAllChats" };

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "opencodeAcp.chatView";

  private view: vscode.WebviewView | undefined;
  private promptInFlight = false;
  private readonly disposables: vscode.Disposable[] = [];
  private storage: SessionStorage;
  private currentChatId: string | null = null;
  private chatMessages: ChatMessage[] = [];
  private chatTitle: string = "";
  private currentChatCreatedAt = 0;
  private assistantResponseBuffer = "";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly acp: AcpClient
  ) {
    this.storage = new SessionStorage();
    this.disposables.push(
      this.acp.onDidStateChange((state) => {
        this.post({ type: "connectionState", state });
      }),
      this.acp.onDidSessionUpdate((update) => {
        this.handleSessionUpdate(update);
      }),
      this.acp.onDidMetadataChange((metadata) => {
        this.post({ type: "metadata", metadata });
      })
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewIncomingMessage) => {
      await this.handleMessage(message);
    });

    if (vscode.workspace.getConfiguration("opencodeAcp").get<boolean>("autoConnect", true)) {
      void this.connect();
    }
  }

  public async connect(): Promise<void> {
    try {
      await this.ensureConnectedSession();

      if (!this.currentChatId) {
        await this.loadLatestChatFromStorage();
      }

      this.post({ type: "connected", sessionId: this.acp.currentSessionId });
      if (this.currentChatId) {
        this.publishCurrentChat();
      } else {
        this.post({ type: "chatReset" });
      }
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public async newSession(): Promise<void> {
    if (this.promptInFlight) {
      this.post({ type: "error", message: "Cannot start a new session while a response is running." });
      return;
    }

    try {
      if (this.acp.connectionState !== "connected") {
        await this.acp.connect();
      }
      
      if (this.currentChatId && this.chatMessages.length > 0) {
        await this.saveCurrentChat();
      }
      
      await this.ensureConnectedSession(true);

      this.currentChatId = null;
      this.chatTitle = "";
      this.currentChatCreatedAt = 0;
      this.chatMessages = [];
      this.assistantResponseBuffer = "";
      this.post({ type: "chatReset" });
      this.post({ type: "connected", sessionId: this.acp.currentSessionId });
      await this.loadChatHistory();
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public async switchChat(chatId: string): Promise<void> {
    if (this.promptInFlight) {
      this.post({ type: "error", message: "Cannot switch chats while a response is running." });
      return;
    }

    try {
      if (this.currentChatId && this.chatMessages.length > 0) {
        await this.saveCurrentChat();
      }

      const chat = await this.storage.loadChat(chatId);
      if (!chat) {
        this.post({ type: "error", message: "Chat not found" });
        return;
      }

      this.currentChatId = chat.id;
      this.chatTitle = chat.title;
      this.currentChatCreatedAt = chat.createdAt;
      this.chatMessages = [...chat.messages];
      this.assistantResponseBuffer = "";

      await this.ensureConnectedSession(true);

      this.publishCurrentChat();
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public async deleteChat(chatId: string): Promise<void> {
    if (this.promptInFlight) {
      this.post({ type: "error", message: "Cannot delete chats while a response is running." });
      return;
    }

    try {
      if (chatId === this.currentChatId) {
        await this.newSession();
      }
      await this.storage.deleteChat(chatId);
      const chats = await this.storage.loadChatMetadata();
      this.post({ type: "chatListUpdated", chats });
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public async clearAllChats(): Promise<void> {
    if (this.promptInFlight) {
      this.post({ type: "error", message: "Cannot clear chats while a response is running." });
      return;
    }

    try {
      await this.storage.clearAllChats();

      this.currentChatId = null;
      this.chatTitle = "";
      this.currentChatCreatedAt = 0;
      this.chatMessages = [];
      this.assistantResponseBuffer = "";
      this.post({ type: "chatReset" });
      const chats = await this.storage.loadChatMetadata();
      this.post({ type: "chatListUpdated", chats });

      if (this.acp.connectionState === "connected") {
        try {
          await this.ensureConnectedSession(true);
          this.post({ type: "connected", sessionId: this.acp.currentSessionId });
        } catch (error) {
          this.post({ type: "error", message: `Chats were cleared, but session reset failed: ${this.toError(error)}` });
        }
      }
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public async loadChatHistory(): Promise<void> {
    try {
      const chats = await this.storage.loadChatMetadata();
      this.post({ type: "chatListUpdated", chats });
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  private async saveCurrentChat(): Promise<void> {
    if (!this.currentChatId) return;

    const createdAt = this.currentChatCreatedAt || Date.now();
    const updatedAt = Date.now();
    await this.storage.saveChat({
      id: this.currentChatId,
      title: this.chatTitle,
      createdAt,
      updatedAt,
      sessionId: this.acp.currentSessionId ?? undefined,
      messages: this.chatMessages
    });
    this.currentChatCreatedAt = createdAt;
  }

  public async cancel(): Promise<void> {
    try {
      await this.acp.cancelTurn();
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public clear(): void {
    this.chatMessages = [];
    this.assistantResponseBuffer = "";
    this.post({ type: "chatReset" });
    if (this.currentChatId) {
      void this.saveCurrentChat();
    }
  }

  public showLogs(): void {
    this.acp.showLogs();
  }

  private async handleMessage(message: WebviewIncomingMessage): Promise<void> {
    switch (message.type) {
      case "ready": {
        this.post({ type: "connectionState", state: this.acp.connectionState });
        this.post({ type: "metadata", metadata: this.acp.sessionMetadata });
        this.post({ type: "connected", sessionId: this.acp.currentSessionId });
        await this.loadChatHistory();
        if (this.currentChatId) {
          this.publishCurrentChat();
        } else {
          this.post({ type: "chatReset" });
        }
        break;
      }
      case "connect": {
        await this.connect();
        break;
      }
      case "newSession": {
        await this.newSession();
        break;
      }
      case "switchChat": {
        await this.switchChat(message.chatId);
        break;
      }
      case "deleteChat": {
        await this.deleteChat(message.chatId);
        break;
      }
      case "loadChatHistory": {
        await this.loadChatHistory();
        break;
      }
      case "cancel": {
        await this.cancel();
        break;
      }
      case "clear": {
        this.clear();
        break;
      }
      case "clearAllChats": {
        await this.clearAllChats();
        break;
      }
      case "setMode": {
        try {
          await this.acp.setMode(message.modeId);
        } catch (error) {
          this.post({ type: "error", message: this.toError(error) });
        }
        break;
      }
      case "setModel": {
        try {
          await this.acp.setModel(message.modelId);
        } catch (error) {
          this.post({ type: "error", message: this.toError(error) });
        }
        break;
      }
      case "showLogs": {
        this.showLogs();
        break;
      }
      case "prompt": {
        await this.handlePrompt(message.text, Boolean(message.includeSelection));
        break;
      }
    }
  }

  private async handlePrompt(text: string, includeSelection: boolean): Promise<void> {
    if (this.promptInFlight) {
      this.post({ type: "error", message: "Previous request is still running. Press Stop and try again." });
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    if (!this.currentChatId) {
      const { id, title, createdAt } = await this.storage.createChat(this.acp.currentSessionId ?? undefined);
      this.currentChatId = id;
      this.chatTitle = title;
      this.currentChatCreatedAt = createdAt;
      await this.loadChatHistory();
    }

    this.chatMessages.push({ role: "user", content: trimmed, timestamp: Date.now() });
    if (this.chatMessages.length === 1) {
      this.chatTitle = trimmed.substring(0, 50) + (trimmed.length > 50 ? "..." : "");
      this.post({ type: "chatLoaded", chatId: this.currentChatId, title: this.chatTitle });
    }

    this.promptInFlight = true;
    this.assistantResponseBuffer = "";
    this.post({ type: "promptStart" });

    try {
      await this.ensureConnectedSession();

      const promptBase = includeSelection
        ? this.withSelectionContext(trimmed)
        : trimmed;
      const history = this.chatMessages.slice(0, -1);
      const prompt = this.withChatHistoryContext(promptBase, history);

      const response = await this.acp.sendPrompt(prompt);
      
      this.post({
        type: "promptEnd",
        stopReason: response.stopReason,
        usage: response.usage ?? null
      });

      this.flushAssistantResponseToHistory();
      
      await this.saveCurrentChat();
      await this.loadChatHistory();
    } catch (error) {
      this.flushAssistantResponseToHistory();
      this.post({ type: "error", message: this.toError(error) });
      this.post({ type: "promptEnd", stopReason: "error" });
      await this.saveCurrentChat();
      await this.loadChatHistory();
    } finally {
      this.assistantResponseBuffer = "";
      this.promptInFlight = false;
    }
  }

  private async loadLatestChatFromStorage(): Promise<void> {
    const metadata = await this.storage.loadChatMetadata();
    const latest = metadata[0];
    if (!latest) {
      this.currentChatId = null;
      this.chatTitle = "";
      this.currentChatCreatedAt = 0;
      this.chatMessages = [];
      return;
    }

    const chat = await this.storage.loadChat(latest.id);
    if (!chat) {
      this.currentChatId = null;
      this.chatTitle = "";
      this.currentChatCreatedAt = 0;
      this.chatMessages = [];
      return;
    }

    this.currentChatId = chat.id;
    this.chatTitle = chat.title;
    this.currentChatCreatedAt = chat.createdAt;
    this.chatMessages = [...chat.messages];
  }

  private flushAssistantResponseToHistory(): void {
    const text = this.assistantResponseBuffer;
    if (!text.trim()) {
      return;
    }
    this.chatMessages.push({ role: "assistant", content: text, timestamp: Date.now() });
    this.assistantResponseBuffer = "";
  }

  private withChatHistoryContext(prompt: string, history: ChatMessage[]): string {
    if (!history.length) {
      return prompt;
    }

    if (prompt.trimStart().startsWith("/")) {
      return prompt;
    }

    const maxMessages = 24;
    const clippedHistory = history.slice(-maxMessages);
    const lines = clippedHistory.map((message) => {
      const role = message.role === "user" ? "User" : "Assistant";
      const normalized = message.content.replace(/\s+/g, " ").trim();
      const clipped = normalized.length > 1200 ? `${normalized.slice(0, 1200)}...` : normalized;
      return `${role}: ${clipped}`;
    });

    return [
      "Keep continuity with the ongoing chat history below.",
      "",
      "Chat history:",
      ...lines,
      "",
      "Now answer this new user message:",
      prompt
    ].join("\n");
  }

  private withSelectionContext(prompt: string): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return prompt;
    }

    const selectedText = editor.document.getText(editor.selection);
    if (!selectedText.trim()) {
      return prompt;
    }

    const startLine = editor.selection.start.line + 1;
    const endLine = editor.selection.end.line + 1;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);

    const context = [
      "",
      "Context from current selection:",
      `File: ${relativePath}:${startLine}-${endLine}`,
      "```",
      selectedText,
      "```"
    ].join("\n");

    return `${prompt}\n${context}`;
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update as { sessionUpdate?: string; [key: string]: unknown };
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = this.extractChunkText(update);
      if (text) {
        this.assistantResponseBuffer += text;
      }
    }

    this.post({
      type: "sessionUpdate",
      sessionId: notification.sessionId,
      update: notification.update
    });
  }

  private publishCurrentChat(): void {
    if (!this.currentChatId) {
      return;
    }

    this.post({ type: "chatReset" });
    for (const message of this.chatMessages) {
      this.post({ type: "chatHistoryMessage", role: message.role, content: message.content, timestamp: message.timestamp });
    }
    this.post({ type: "chatLoaded", chatId: this.currentChatId, title: this.chatTitle });
  }

  private extractChunkText(update: { content?: unknown; text?: unknown; [key: string]: unknown }): string {
    if (typeof update.text === "string") {
      return update.text;
    }

    if (typeof update.content === "string") {
      return update.content;
    }

    if (update.content && typeof update.content === "object") {
      const content = update.content as { text?: unknown };
      if (typeof content.text === "string") {
        return content.text;
      }
    }

    return "";
  }

  private async ensureConnectedSession(forceNewSession = false): Promise<void> {
    if (this.acp.connectionState !== "connected") {
      await this.acp.connect();
    }

    if (forceNewSession || !this.acp.currentSessionId) {
      await this.acp.newSession();
    }
  }

  private post(payload: Record<string, unknown>): void {
    this.view?.webview.postMessage(payload);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.css")
    );

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src ${webview.cspSource};" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>OpenCode ACP Chat</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private toError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
