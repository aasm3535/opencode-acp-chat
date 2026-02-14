# AGENTS.md

Development guidelines for the OpenCode ACP Chat VS Code extension.

## Build Commands

```bash
npm run typecheck      # Run TypeScript type checking
npm run compile        # Compile TypeScript and bundle with esbuild
npm run watch          # Watch mode (auto-rebuild on changes)
npm run build          # Production build (minified, no source maps)
npm run package        # Package as VSIX for Marketplace
```

Press `F5` in VS Code to launch Extension Development Host for testing. No test framework is configured.

## Code Style Guidelines

### TypeScript Configuration

- Target: ES2022, Module: CommonJS
- Strict mode enabled (noImplicitAny, strictNullChecks)
- Always use explicit types for parameters and return values
- Use `unknown` instead of `any` for type-safe error handling

### Import Order

```typescript
// 1. VS Code API
import * as vscode from "vscode";

// 2. Third-party dependencies
import { marked } from "marked";

// 3. Local imports (relative)
import { AcpClient } from "./acp/AcpClient";
import "./main.css";
```

### Naming Conventions

- Classes/Types: PascalCase (`ChatViewProvider`, `ConnectionState`)
- Methods/Variables: camelCase (`connect()`, `loadChatMetadata()`)
- Private members: `private` keyword (no underscores)
- Files: PascalCase for classes, lowercase-with-hyphens for utilities

### Error Handling

```typescript
try {
  await this.acp.connect();
} catch (error) {
  this.post({ type: "error", message: this.toError(error) });
}

private toError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

### Async/Await Patterns

- Always use `async/await` instead of Promise chains
- Use `void` prefix for fire-and-forget: `void this.connect()`
- Mark void returns: `public async connect(): Promise<void>`

### Disposal Pattern

```typescript
export class SomeClass implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  
  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

// In extension.ts: context.subscriptions.push(acpClient, chatProvider);
```

### Webview Communication

```typescript
type WebviewIncomingMessage =
  | { type: "ready" }
  | { type: "prompt"; text: string };

private post(payload: Record<string, unknown>): void {
  this.view?.webview.postMessage(payload);
}
```

### File System Operations

```typescript
// Use fs.existsSync() for checks
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// Prefer os.homedir() over HOME
const homeDir = os.homedir();
```

### CSS/Styling

- Use CSS custom properties with theme fallbacks: `var(--vscode-sideBar-background, #141414)`
- Prefix custom variables: `--app-bg`, `--panel-border`
- Use descriptive class names: `.chat-item`, `.message.user`
- Keep transitions brief: 120ms-220ms

### TypeScript Patterns

```typescript
// Discriminated unions
type Message = { type: "text"; content: string } | { type: "error"; message: string };

// Type guards
if (error instanceof Error) return error.message;

// Optional chaining
const title = message.title ?? "Default";
```

### Project Structure

```
src/
├── acp/       # ACP protocol client
├── ui/        # VS Code UI components
├── storage/   # Data persistence
└── webview/   # Frontend (TS + CSS)
```

### Configuration Access

```typescript
const config = vscode.workspace.getConfiguration("opencodeAcp");
const command = config.get<string>("command", "opencode");
```

### Build System (esbuild)

- Extension: Node platform, CommonJS, external "vscode"
- Webview: Browser platform, IIFE format
- Production builds minify without source maps
- Dev builds use inline source maps

### When Adding Features

1. Create/modify TypeScript interfaces for type safety
2. Update `WebviewIncomingMessage` types if changing protocol
3. Add disposal logic for event listeners/commands
4. Run `npm run typecheck` before commits
5. Test manually in Extension Development Host

### Comments

- **DO NOT add comments** unless absolutely necessary
- Self-documenting code preferred over explanatory comments
- TODO comments acceptable for placeholders
