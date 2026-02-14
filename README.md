# OpenCode ACP Chat

<div align="center">

**A polished ACP chat client for OpenCode in Visual Studio Code**

[![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)](https://github.com/yourusername/opencode-vsc)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.105.0%2B-blue.svg)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue.svg)](https://www.typescriptlang.org/)

</div>

---

## Features

| Feature | Description |
|---------|-------------|
| **Streaming Responses** | Real-time streaming assistant responses for instant feedback |
| **Tool Call Timeline** | Visual timeline with status indicators and detailed output |
| **Mode & Model Selectors** | Easy switching between different AI modes and models |
| **Context Integration** | Optional "include current selection" for smarter conversations |
| **Polished UI** | Modern, clean interface designed for productivity |
| **Auto-Connect** | Seamless connection when chat view opens |
| **Flexible Configuration** | Extensive customization options |

## Demo

<div align="center">
  <video width="800" controls>
    <source src="video/demo.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
  <p>A quick demo of OpenCode ACP Chat in action</p>
</div>

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Press `Ctrl+Shift+X` (or `Cmd+Shift+X` on macOS)
3. Search for **OpenCode ACP Chat**
4. Click **Install**

### From VSIX Package

```bash
code --install-extension opencode-acp-chat-0.0.1.vsix
```

## Quick Start

1. **Open the Chat Panel**
   - Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS)
   - Type "OpenCode ACP: Connect"
   - Press Enter

2. **Start Chatting**
   - Type your message in the chat input
   - Press Enter to send
   - Watch the AI respond in real-time!

3. **Customize Experience**
   - Click the gear icon to open settings
   - Configure models, permissions, and more

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `opencodeAcp.command` | string | `opencode` | Command used to launch ACP agent |
| `opencodeAcp.args` | array | `["acp"]` | Arguments passed to ACP command |
| `opencodeAcp.cwd` | string | `""` | Working directory (empty = workspace folder) |
| `opencodeAcp.env` | object | `{}` | Environment variables for ACP process |
| `opencodeAcp.autoConnect` | boolean | `true` | Auto-connect when chat view opens |
| `opencodeAcp.permissionMode` | enum | `ask` | Tool permission behavior (`ask` or `allowAll`) |
| `opencodeAcp.logTraffic` | boolean | `false` | Log ACP protocol traffic and stderr |
| `opencodeAcp.defaultModel` | string | `opencode` | Preferred default model |

### Example Configuration

```json
{
  "opencodeAcp.command": "opencode",
  "opencodeAcp.args": ["acp", "--verbose"],
  "opencodeAcp.autoConnect": true,
  "opencodeAcp.permissionMode": "ask",
  "opencodeAcp.defaultModel": "gpt-4"
}
```

## Commands

| Command | Keyboard | Description |
|---------|----------|-------------|
| `OpenCode ACP: Connect` | - | Connect to OpenCode ACP server |
| `OpenCode ACP: New Session` | - | Start a new chat session |
| `OpenCode ACP: Cancel Turn` | - | Cancel current AI response |
| `OpenCode ACP: Clear Chat` | - | Clear the chat history |
| `OpenCode ACP: Show Logs` | - | View ACP protocol logs |

## Development

### Prerequisites

- Node.js (v16 or higher)
- VS Code
- TypeScript

### Setup

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch for changes
npm run watch
```

### Development Mode

1. Clone the repository
2. Run `npm install`
3. Open the project in VS Code
4. Press `F5` to launch Extension Development Host
5. Test the extension in the new VS Code window

### Build & Package

```bash
# Type check
npm run typecheck

# Build for production
npm run build

# Package as VSIX
npm run package
```

## Project Structure

```
opencode-vsc/
├── src/
│   ├── acp/
│   │   └── AcpClient.ts          # ACP protocol client
│   ├── ui/
│   │   └── ChatViewProvider.ts   # Chat view logic
│   ├── webview/
│   │   ├── main.ts               # Webview logic
│   │   └── main.css              # Webview styles
│   └── extension.ts              # Extension entry point
├── resources/
│   ├── opencode-logo-light.svg
│   ├── opencode-logo-dark.svg
│   └── icon.svg
├── package.json
├── tsconfig.json
├── esbuild.js
└── README.md
```

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Agent Client Protocol SDK](https://github.com/agentclientprotocol/sdk)
- Inspired by modern AI chat interfaces
- Powered by [OpenCode](https://opencode.ai)

## Support

- [Documentation](https://opencode.ai/docs)
- [Report Issues](https://github.com/yourusername/opencode-vsc/issues)
- [Discord Community](https://discord.gg/opencode)
- [Email Support](mailto:support@opencode.ai)

---

<div align="center">

**Made with ❤️ by the OpenCode team**

[Back to Top](#opencode-acp-chat)

</div>
