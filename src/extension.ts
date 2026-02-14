import * as vscode from "vscode";
import { AcpClient } from "./acp/AcpClient";
import { ChatViewProvider } from "./ui/ChatViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const acpClient = new AcpClient();
  const chatProvider = new ChatViewProvider(context.extensionUri, acpClient);

  context.subscriptions.push(
    acpClient,
    chatProvider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider),
    vscode.commands.registerCommand("opencodeAcp.connect", async () => {
      await chatProvider.connect();
    }),
    vscode.commands.registerCommand("opencodeAcp.newSession", async () => {
      await chatProvider.newSession();
    }),
    vscode.commands.registerCommand("opencodeAcp.cancel", async () => {
      await chatProvider.cancel();
    }),
    vscode.commands.registerCommand("opencodeAcp.clear", () => {
      chatProvider.clear();
    }),
    vscode.commands.registerCommand("opencodeAcp.showLog", () => {
      chatProvider.showLogs();
    })
  );
}

export function deactivate(): void {
  // no-op; disposables are handled by VS Code
}
