import * as path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as vscode from "vscode";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalCommandRequest,
  type KillTerminalCommandResponse,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionModeResponse,
  type SetSessionModelResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse
} from "@agentclientprotocol/sdk";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface SessionMetadata {
  modes?: NewSessionResponse["modes"];
  models?: NewSessionResponse["models"];
  commands?: unknown[];
  configOptions?: NewSessionResponse["configOptions"];
}

interface ManagedTerminal {
  id: string;
  proc: ReturnType<typeof spawn>;
  output: string;
  outputByteLimit: number | null;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

export class AcpClient implements vscode.Disposable {
  private process: ReturnType<typeof spawn> | null = null;
  private connection: ClientSideConnection | null = null;
  private state: ConnectionState = "disconnected";
  private sessionId: string | null = null;
  private metadata: SessionMetadata = {};
  private readonly outputChannel = vscode.window.createOutputChannel("OpenCode ACP");
  private readonly trafficChannel = vscode.window.createOutputChannel("OpenCode ACP Traffic");
  private readonly terminals = new Map<string, ManagedTerminal>();
  private isDisposing = false;
  private terminalCounter = 0;

  private readonly onStateEmitter = new vscode.EventEmitter<ConnectionState>();
  private readonly onSessionUpdateEmitter = new vscode.EventEmitter<SessionNotification>();
  private readonly onMetadataEmitter = new vscode.EventEmitter<SessionMetadata>();

  public readonly onDidStateChange = this.onStateEmitter.event;
  public readonly onDidSessionUpdate = this.onSessionUpdateEmitter.event;
  public readonly onDidMetadataChange = this.onMetadataEmitter.event;

  public get connectionState(): ConnectionState {
    return this.state;
  }

  public get currentSessionId(): string | null {
    return this.sessionId;
  }

  public get sessionMetadata(): SessionMetadata {
    return this.metadata;
  }

  public showLogs(): void {
    this.outputChannel.show(true);
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.onStateEmitter.fire(next);
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private logTraffic(message: string): void {
    if (!this.isTrafficEnabled()) {
      return;
    }
    this.trafficChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private isTrafficEnabled(): boolean {
    return vscode.workspace.getConfiguration("opencodeAcp").get<boolean>("logTraffic", false);
  }

  private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private resolveDefaultCwd(): string {
    const configured = vscode.workspace.getConfiguration("opencodeAcp").get<string>("cwd", "").trim();
    if (configured) {
      return this.interpolateWorkspaceVar(configured);
    }
    return this.getWorkspaceFolder()?.uri.fsPath ?? process.cwd();
  }

  private interpolateWorkspaceVar(value: string): string {
    const workspacePath = this.getWorkspaceFolder()?.uri.fsPath ?? "";
    return value.replaceAll("${workspaceFolder}", workspacePath);
  }

  private resolveConfiguredEnv(): NodeJS.ProcessEnv {
    const configEnv = vscode.workspace.getConfiguration("opencodeAcp").get<Record<string, unknown>>("env", {});
    const env: NodeJS.ProcessEnv = { ...process.env };

    for (const [key, rawValue] of Object.entries(configEnv)) {
      if (typeof rawValue === "string") {
        env[key] = this.interpolateWorkspaceVar(rawValue);
      }
    }
    return env;
  }

  private configuredDefaultModelQuery(): string {
    return vscode.workspace.getConfiguration("opencodeAcp").get<string>("defaultModel", "opencode").trim();
  }

  private resolveConfiguredDefaultModelId(models: NewSessionResponse["models"] | undefined): string | null {
    const query = this.configuredDefaultModelQuery();
    if (!query || !models || typeof models !== "object") {
      return null;
    }

    const available = ((models as { availableModels?: unknown }).availableModels ?? []) as Array<{
      modelId?: string;
      name?: string;
    }>;
    if (!available.length) {
      return null;
    }

    const normalizedQuery = query.toLowerCase();
    const exact = available.find((model) => {
      const id = model.modelId?.toLowerCase();
      const name = model.name?.toLowerCase();
      return id === normalizedQuery || name === normalizedQuery;
    });
    if (exact?.modelId) {
      return exact.modelId;
    }

    const partial = available.find((model) => {
      const id = model.modelId?.toLowerCase() ?? "";
      const name = model.name?.toLowerCase() ?? "";
      return id.includes(normalizedQuery) || name.includes(normalizedQuery);
    });

    return partial?.modelId ?? null;
  }

  public async connect(): Promise<void> {
    if (this.state === "connected") {
      return;
    }
    if (this.state === "connecting") {
      throw new Error("Already connecting to ACP agent");
    }

    this.setState("connecting");
    const command = vscode.workspace.getConfiguration("opencodeAcp").get<string>("command", "opencode").trim();
    const argsRaw = vscode.workspace.getConfiguration("opencodeAcp").get<unknown[]>("args", ["acp"]);
    const args = Array.isArray(argsRaw)
      ? argsRaw.filter((arg): arg is string => typeof arg === "string")
      : ["acp"];

    if (!command) {
      this.setState("disconnected");
      throw new Error("ACP command is empty. Configure opencodeAcp.command");
    }

    this.log(`Starting ACP process: ${command} ${args.join(" ")}`);

    this.process = spawn(command, args, {
      cwd: this.resolveDefaultCwd(),
      env: this.resolveConfiguredEnv(),
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    if (this.process.stderr) {
      this.process.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        this.logTraffic(`[stderr] ${text.trimEnd()}`);
      });
    }

    this.process.on("error", (error) => {
      this.log(`ACP process error: ${error.message}`);
      this.cleanupDisconnected();
    });

    this.process.on("exit", (code, signal) => {
      this.log(`ACP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.cleanupDisconnected();
    });

    if (!this.process.stdin || !this.process.stdout) {
      this.cleanupDisconnected();
      throw new Error("ACP process stdio is not available");
    }

    const stream = ndJsonStream(
      Writable.toWeb(this.process.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(this.process.stdout) as unknown as ReadableStream<Uint8Array>
    );

    const client: Client = {
      sessionUpdate: async (params) => this.handleSessionUpdate(params),
      requestPermission: async (params) => this.handlePermissionRequest(params),
      readTextFile: async (params) => this.handleReadTextFile(params),
      writeTextFile: async (params) => this.handleWriteTextFile(params),
      createTerminal: async (params) => this.handleCreateTerminal(params),
      terminalOutput: async (params) => this.handleTerminalOutput(params),
      waitForTerminalExit: async (params) => this.handleWaitForTerminalExit(params),
      killTerminal: async (params) => this.handleKillTerminal(params),
      releaseTerminal: async (params) => this.handleReleaseTerminal(params)
    };

    this.connection = new ClientSideConnection(() => client, stream);

    let initResponse: InitializeResponse;
    try {
      initResponse = await this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: "opencode-acp-chat",
          title: "OpenCode ACP Chat",
          version: "0.0.1"
        },
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true
          },
          terminal: true
        }
      });
    } catch (error) {
      this.cleanupDisconnected();
      throw new Error(`Failed to initialize ACP connection: ${this.toErrorMessage(error)}`);
    }

    this.log(`Connected. Agent protocol version: ${initResponse.protocolVersion}`);
    this.setState("connected");

    void this.connection.closed.then(() => {
      this.log("ACP connection closed");
      this.cleanupDisconnected();
    });
  }

  private cleanupDisconnected(): void {
    if (this.isDisposing) {
      return;
    }
    this.setState("disconnected");
    this.connection = null;
    this.sessionId = null;
    this.metadata = {};
    this.onMetadataEmitter.fire(this.metadata);

    if (this.process) {
      this.process.removeAllListeners();
      this.process = null;
    }

    for (const terminal of this.terminals.values()) {
      if (!terminal.proc.killed) {
        terminal.proc.kill();
      }
    }
    this.terminals.clear();
  }

  private ensureConnection(): ClientSideConnection {
    if (!this.connection || this.state !== "connected") {
      throw new Error("ACP connection is not active");
    }
    return this.connection;
  }

  private ensureSession(): string {
    if (!this.sessionId) {
      throw new Error("No active ACP session. Create a new session first.");
    }
    return this.sessionId;
  }

  public async newSession(cwd?: string): Promise<NewSessionResponse> {
    const connection = this.ensureConnection();
    const response = await connection.newSession({
      cwd: cwd ?? this.resolveDefaultCwd(),
      mcpServers: []
    });

    this.sessionId = response.sessionId;
    this.metadata = {
      modes: response.modes,
      models: response.models,
      configOptions: response.configOptions,
      commands: []
    };

    const preferredModelId = this.resolveConfiguredDefaultModelId(response.models);
    const currentModelId = (response.models as { currentModelId?: string } | undefined)?.currentModelId;
    if (preferredModelId && preferredModelId !== currentModelId && connection.unstable_setSessionModel) {
      try {
        await connection.unstable_setSessionModel({ sessionId: response.sessionId, modelId: preferredModelId });
        if (this.metadata.models && typeof this.metadata.models === "object") {
          (this.metadata.models as { currentModelId?: string }).currentModelId = preferredModelId;
        }
        this.log(`Applied default model from config: ${preferredModelId}`);
      } catch (error) {
        this.log(`Failed to apply default model '${preferredModelId}': ${this.toErrorMessage(error)}`);
      }
    }

    this.onMetadataEmitter.fire(this.metadata);
    this.log(`Created session ${response.sessionId}`);

    return response;
  }

  public async sendPrompt(text: string): Promise<PromptResponse> {
    const connection = this.ensureConnection();
    const sessionId = this.ensureSession();

    this.logTraffic(`[request] session/prompt: ${text.slice(0, 180)}`);
    return connection.prompt({
      sessionId,
      prompt: [{ type: "text", text }]
    });
  }

  public async cancelTurn(): Promise<void> {
    const connection = this.ensureConnection();
    const sessionId = this.ensureSession();
    await connection.cancel({ sessionId });
  }

  public async setMode(modeId: string): Promise<SetSessionModeResponse | void> {
    const connection = this.ensureConnection();
    const sessionId = this.ensureSession();

    const response = await connection.setSessionMode({ sessionId, modeId });
    if (this.metadata.modes && typeof this.metadata.modes === "object") {
      (this.metadata.modes as { currentModeId?: string }).currentModeId = modeId;
      this.onMetadataEmitter.fire(this.metadata);
    }
    return response;
  }

  public async setModel(modelId: string): Promise<SetSessionModelResponse | void> {
    const connection = this.ensureConnection();
    const sessionId = this.ensureSession();

    if (!connection.unstable_setSessionModel) {
      return;
    }

    const response = await connection.unstable_setSessionModel({ sessionId, modelId });
    if (this.metadata.models && typeof this.metadata.models === "object") {
      (this.metadata.models as { currentModelId?: string }).currentModelId = modelId;
      this.onMetadataEmitter.fire(this.metadata);
    }
    return response;
  }

  private async handleSessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update as { sessionUpdate?: string; [key: string]: unknown };

    if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
      this.metadata = {
        ...this.metadata,
        commands: update.availableCommands
      };
      this.onMetadataEmitter.fire(this.metadata);
    }

    if (update.sessionUpdate === "current_mode_update" && this.metadata.modes) {
      const nextModes = { ...(this.metadata.modes as Record<string, unknown>) };
      nextModes.currentModeId = update.currentModeId;
      this.metadata = {
        ...this.metadata,
        modes: nextModes as NewSessionResponse["modes"]
      };
      this.onMetadataEmitter.fire(this.metadata);
    }

    this.onSessionUpdateEmitter.fire(params);
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const mode = vscode.workspace.getConfiguration("opencodeAcp").get<"ask" | "allowAll">("permissionMode", "ask");
    const allowOption = params.options.find((option) => option.kind === "allow_always")
      ?? params.options.find((option) => option.kind === "allow_once");

    if (mode === "allowAll" && allowOption) {
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOption.optionId
        }
      };
    }

    type PermissionPick = vscode.QuickPickItem & { optionId: string };
    const items: PermissionPick[] = params.options.map((option) => ({
      label: option.name,
      description: option.kind,
      optionId: option.optionId
    }));

    const picked = await vscode.window.showQuickPick<PermissionPick>(items, {
      title: params.toolCall.title ?? "Permission request",
      placeHolder: "OpenCode requests permission"
    });

    if (!picked) {
      return {
        outcome: {
          outcome: "cancelled"
        }
      };
    }

    return {
      outcome: {
        outcome: "selected",
        optionId: picked.optionId
      }
    };
  }

  private async handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const uri = vscode.Uri.file(params.path);
    const bytes = await vscode.workspace.fs.readFile(uri);
    let content = Buffer.from(bytes).toString("utf8");

    const hasLine = typeof params.line === "number";
    const hasLimit = typeof params.limit === "number";
    if (hasLine || hasLimit) {
      const lines = content.split(/\r?\n/);
      const start = hasLine ? Math.max(0, params.line as number) : 0;
      const limit = hasLimit ? Math.max(0, params.limit as number) : lines.length;
      content = lines.slice(start, start + limit).join("\n");
    }

    return { content };
  }

  private async handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const fileUri = vscode.Uri.file(params.path);
    const parentUri = vscode.Uri.file(path.dirname(params.path));

    await vscode.workspace.fs.createDirectory(parentUri);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(params.content, "utf8"));
    return {};
  }

  private appendTerminalOutput(terminal: ManagedTerminal, text: string): void {
    terminal.output += text;

    if (terminal.outputByteLimit !== null) {
      const byteLength = Buffer.byteLength(terminal.output, "utf8");
      if (byteLength > terminal.outputByteLimit) {
        const encoded = Buffer.from(terminal.output, "utf8");
        terminal.output = encoded
          .slice(encoded.length - terminal.outputByteLimit)
          .toString("utf8");
        terminal.truncated = true;
      }
    }
  }

  private async handleCreateTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const id = `terminal-${++this.terminalCounter}-${Date.now()}`;
    const commandEnv = {
      ...process.env,
      ...Object.fromEntries((params.env ?? []).map((envVar) => [envVar.name, envVar.value]))
    };

    const cwd = params.cwd?.trim() || this.resolveDefaultCwd();

    const proc = spawn(params.command, params.args ?? [], {
      cwd,
      env: commandEnv,
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let resolveExit = () => {};
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const terminal: ManagedTerminal = {
      id,
      proc,
      output: "",
      outputByteLimit: params.outputByteLimit ?? null,
      truncated: false,
      exitCode: null,
      signal: null,
      exitPromise,
      resolveExit
    };

    proc.stdout.on("data", (chunk) => this.appendTerminalOutput(terminal, chunk.toString("utf8")));
    proc.stderr.on("data", (chunk) => this.appendTerminalOutput(terminal, chunk.toString("utf8")));

    proc.on("exit", (code, signal) => {
      terminal.exitCode = code;
      terminal.signal = signal;
      terminal.resolveExit();
    });

    proc.on("error", (error) => {
      this.appendTerminalOutput(terminal, `\n${error.message}`);
      terminal.exitCode = 1;
      terminal.resolveExit();
    });

    this.terminals.set(id, terminal);
    return { terminalId: id };
  }

  private async handleTerminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    const exitStatus = terminal.exitCode === null
      ? null
      : {
        exitCode: terminal.exitCode,
        ...(terminal.signal ? { signal: terminal.signal } : {})
      };

    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus
    };
  }

  private async handleWaitForTerminalExit(
    params: WaitForTerminalExitRequest
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Unknown terminal: ${params.terminalId}`);
    }

    await terminal.exitPromise;

    return {
      exitCode: terminal.exitCode,
      ...(terminal.signal ? { signal: terminal.signal } : {})
    };
  }

  private async handleKillTerminal(
    params: KillTerminalCommandRequest
  ): Promise<KillTerminalCommandResponse | void> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      return {};
    }

    if (!terminal.proc.killed) {
      terminal.proc.kill();
    }
    return {};
  }

  private async handleReleaseTerminal(
    params: ReleaseTerminalRequest
  ): Promise<ReleaseTerminalResponse | void> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      return {};
    }

    if (!terminal.proc.killed) {
      terminal.proc.kill();
    }

    this.terminals.delete(params.terminalId);
    return {};
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  public async disconnect(): Promise<void> {
    this.isDisposing = true;
    try {
      if (this.process && !this.process.killed) {
        this.process.kill();
      }
    } finally {
      this.isDisposing = false;
      this.cleanupDisconnected();
    }
  }

  public dispose(): void {
    void this.disconnect();
    this.onStateEmitter.dispose();
    this.onSessionUpdateEmitter.dispose();
    this.onMetadataEmitter.dispose();
    this.outputChannel.dispose();
    this.trafficChannel.dispose();
  }
}
