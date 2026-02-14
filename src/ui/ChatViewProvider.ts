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
  | { type: "deleteChat"; chatId: string };

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "opencodeAcp.chatView";

  private view: vscode.WebviewView | undefined;
  private promptInFlight = false;
  private readonly disposables: vscode.Disposable[] = [];
  private storage: SessionStorage;
  private currentChatId: string | null = null;
  private chatMessages: ChatMessage[] = [];
  private chatTitle: string = "";

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
      await this.acp.connect();
      if (!this.currentChatId) {
        const { id, title } = await this.storage.createChat(this.acp.currentSessionId ?? undefined);
        this.currentChatId = id;
        this.chatTitle = title;
        this.chatMessages = [];
      } else if (!this.acp.currentSessionId) {
        await this.acp.newSession();
      }
      this.post({ type: "connected", sessionId: this.acp.currentSessionId });
      this.post({ type: "chatLoaded", chatId: this.currentChatId, title: this.chatTitle });
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public async newSession(): Promise<void> {
    try {
      await this.acp.connect();
      
      if (this.currentChatId && this.chatMessages.length > 0) {
        await this.saveCurrentChat();
      }
      
      const { id, title } = await this.storage.createChat();
      this.currentChatId = id;
      this.chatTitle = title;
      this.chatMessages = [];
      this.post({ type: "chatReset" });
      this.post({ type: "chatLoaded", chatId: id, title });
      
      await this.acp.newSession();
      this.post({ type: "connected", sessionId: this.acp.currentSessionId });
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public async switchChat(chatId: string): Promise<void> {
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
      this.chatMessages = chat.messages;

      this.post({ type: "chatReset" });
      
      for (const msg of chat.messages) {
        this.post({ type: "chatHistoryMessage", role: msg.role, content: msg.content, timestamp: msg.timestamp });
      }

      this.post({ type: "chatLoaded", chatId: chat.id, title: chat.title });

      if (chat.sessionId) {
        await this.acp.connect();
      }
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public async deleteChat(chatId: string): Promise<void> {
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

    await this.storage.saveChat({
      id: this.currentChatId,
      title: this.chatTitle,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: this.acp.currentSessionId ?? undefined,
      messages: this.chatMessages
    });
  }

  public async cancel(): Promise<void> {
    try {
      await this.acp.cancelTurn();
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
    }
  }

  public clear(): void {
    this.post({ type: "chatReset" });
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
          this.post({ type: "chatLoaded", chatId: this.currentChatId, title: this.chatTitle });
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
      const { id, title } = await this.storage.createChat(this.acp.currentSessionId ?? undefined);
      this.currentChatId = id;
      this.chatTitle = title;
    }

    this.chatMessages.push({ role: "user", content: trimmed, timestamp: Date.now() });
    if (this.chatMessages.length === 1) {
      this.chatTitle = trimmed.substring(0, 50) + (trimmed.length > 50 ? "..." : "");
      this.post({ type: "chatLoaded", chatId: this.currentChatId, title: this.chatTitle });
    }

    this.promptInFlight = true;
    this.post({ type: "promptStart" });

    try {
      if (this.acp.connectionState !== "connected") {
        await this.acp.connect();
      }
      if (!this.acp.currentSessionId) {
        await this.acp.newSession();
      }

      const prompt = includeSelection
        ? this.withSelectionContext(trimmed)
        : trimmed;

      const response = await this.acp.sendPrompt(prompt);
      
      this.post({
        type: "promptEnd",
        stopReason: response.stopReason,
        usage: response.usage ?? null
      });
      
      await this.saveCurrentChat();
    } catch (error) {
      this.post({ type: "error", message: this.toError(error) });
      this.post({ type: "promptEnd", stopReason: "error" });
    } finally {
      this.promptInFlight = false;
    }
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
    this.post({
      type: "sessionUpdate",
      sessionId: notification.sessionId,
      update: notification.update
    });
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
    <div id="app">
      <div id="chatHeader" class="chat-header">
        <span id="chatsLink" class="chats-link">View chats</span>
      </div>
      <main id="messages" class="messages"></main>

      <form id="composer" class="composer" novalidate>
        <div class="input-shell">
          <textarea id="promptInput" rows="1" placeholder="Ask anything, @ context, / commands"></textarea>

          <div class="input-footer">
            <div class="selector-row">
              <div class="dropdown mode-dropdown" id="modeDropdown">
                <button id="modeTrigger" class="dropdown-trigger mode-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                  <span class="trigger-main">
                    <span id="modeGlyph" class="mode-glyph" aria-hidden="true"></span>
                    <span id="modeValue">Build</span>
                  </span>
                  <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m6 9 6 6 6-9"></path>
                  </svg>
                </button>
                <div id="modeMenu" class="dropdown-menu" role="listbox" aria-label="Mode"></div>
              </div>

              <div class="dropdown model-dropdown" id="modelDropdown">
                <button id="modelTrigger" class="dropdown-trigger model-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                  <span class="model-label">Model</span>
                  <span id="modelValue" class="model-value">auto</span>
                  <svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m6 9 6 6 6-9"></path>
                  </svg>
                </button>
                <div id="modelMenu" class="dropdown-menu model-menu" role="listbox" aria-label="Model"></div>
              </div>
            </div>

            <button id="sendBtn" class="send-btn" type="submit" aria-label="Send">
              <svg class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 21V3"></path>
                <path d="m5 10 7-7 7 7"></path>
              </svg>
            </button>
          </div>
        </div>
      </form>
    </div>
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
