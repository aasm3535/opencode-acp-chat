import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface ChatMetadata {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
}

interface ChatData extends ChatMetadata {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }>;
}

export class SessionStorage {
  private readonly chatDir: string;
  private readonly chatsFile: string;
  private cache: ChatMetadata[] = [];

  constructor() {
    const homeDir = os.homedir();
    this.chatDir = path.join(homeDir, ".opencode-acp-chat");
    this.chatsFile = path.join(this.chatDir, "chats.json");
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.chatDir)) {
      fs.mkdirSync(this.chatDir, { recursive: true });
    }
  }

  async loadChatMetadata(): Promise<ChatMetadata[]> {
    try {
      if (fs.existsSync(this.chatsFile)) {
        const content = fs.readFileSync(this.chatsFile, "utf-8");
        this.cache = JSON.parse(content);
      }
    } catch (error) {
      console.error("Failed to load chat metadata:", error);
      this.cache = [];
    }
    return this.cache.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveChat(chat: ChatData): Promise<void> {
    const chatFile = path.join(this.chatDir, `${chat.id}.json`);
    fs.writeFileSync(chatFile, JSON.stringify(chat, null, 2), "utf-8");

    const existingIndex = this.cache.findIndex(c => c.id === chat.id);
    const metadata: ChatMetadata = {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: Date.now(),
      sessionId: chat.sessionId
    };

    if (existingIndex >= 0) {
      this.cache[existingIndex] = metadata;
    } else {
      this.cache.push(metadata);
    }

    await this.saveMetadata();
  }

  async createChat(sessionId?: string): Promise<{ id: string; title: string }> {
    const id = this.generateId();
    const title = `Chat ${new Date().toLocaleDateString()}`;
    const chat: ChatData = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId,
      messages: []
    };

    await this.saveChat(chat);
    return { id, title };
  }

  async loadChat(id: string): Promise<ChatData | null> {
    try {
      const chatFile = path.join(this.chatDir, `${id}.json`);
      if (fs.existsSync(chatFile)) {
        const content = fs.readFileSync(chatFile, "utf-8");
        return JSON.parse(content);
      }
    } catch (error) {
      console.error("Failed to load chat:", error);
    }
    return null;
  }

  async deleteChat(id: string): Promise<void> {
    try {
      const chatFile = path.join(this.chatDir, `${id}.json`);
      if (fs.existsSync(chatFile)) {
        fs.unlinkSync(chatFile);
      }
      this.cache = this.cache.filter(c => c.id !== id);
      await this.saveMetadata();
    } catch (error) {
      console.error("Failed to delete chat:", error);
    }
  }

  private async saveMetadata(): Promise<void> {
    try {
      fs.writeFileSync(this.chatsFile, JSON.stringify(this.cache, null, 2), "utf-8");
    } catch (error) {
      console.error("Failed to save metadata:", error);
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  getChatDir(): string {
    return this.chatDir;
  }
}
