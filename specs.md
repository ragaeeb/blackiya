# LLM Response Capture Extension - Technical Specification

## Overview
A performant Chrome extension built with WXT framework to capture and save JSON responses from popular LLM platforms (ChatGPT, Gemini, Grok, etc.).

## Tech Stack

### Core Framework
- **WXT v0.20.13** (Latest stable)
  - Modern file-based extension framework
  - Built on Vite for fast HMR
  - TypeScript-first with zero config
  - Cross-browser support (Chrome, Firefox, Edge, Safari)

### Package Manager & Tooling
- **Bun v1.3+** (Latest)
  - Ultra-fast package manager
  - Native TypeScript support
  - Built-in test runner
  
- **Biome v2.3.11** (Latest)
  - Fast linter and formatter (Rust-based)
  - Replaces ESLint + Prettier
  - 340+ lint rules
  - VS Code extension available

### Development Stack
- **TypeScript 5.x** (included with WXT)
- **Vite 6.x** (bundler, included with WXT)
- **Manifest V3** (Chrome's latest extension API)

## Project Structure

```
llm-response-capture/
├── .vscode/
│   └── settings.json           # Biome formatter config
├── entrypoints/
│   ├── background.ts           # Service worker for API interception
│   ├── content/
│   │   ├── chatgpt.ts         # ChatGPT-specific content script
│   │   ├── gemini.ts          # Gemini content script
│   │   └── grok.ts            # Grok content script
│   ├── popup/
│   │   ├── index.html         # Extension popup UI
│   │   └── App.tsx            # Popup logic (optional React/vanilla)
│   └── options.html           # Settings page (optional)
├── components/                 # Reusable components (if using UI framework)
├── utils/
│   ├── storage.ts             # Browser storage utilities
│   ├── capture.ts             # Core capture logic
│   └── types.ts               # TypeScript interfaces
├── public/
│   └── icon/                  # Extension icons
│       ├── 16.png
│       ├── 48.png
│       └── 128.png
├── .gitignore
├── biome.json                 # Biome config
├── bun.lockb                  # Bun lock file
├── package.json
├── tsconfig.json
├── wxt.config.ts              # WXT configuration
└── README.md
```

## Architecture

### 1. Background Service Worker
- Intercepts network requests to LLM APIs
- Listens for specific endpoints:
  - ChatGPT: `https://chatgpt.com/backend-api/conversation/*`
  - Gemini: `https://gemini.google.com/api/*`
  - Grok: `https://x.com/api/grok/*` (to be verified)
- Extracts JSON responses
- Sends to content script for user action

### 2. Content Scripts
- Platform-specific injection
- Adds "Save Conversation" button to UI
- Communicates with background script
- Triggers download of JSON file

### 3. Storage
- Uses `chrome.storage.local` for settings
- Stores capture history (optional)
- User preferences (auto-save, naming convention)

## Key Features (Phase 1 - ChatGPT)

### Core Functionality
1. **Network Interception**
   - Monitor `backend-api/conversation/{id}` endpoint
   - Capture full conversation JSON
   - Parse response structure

2. **UI Integration**
   - Inject "Save" button on ChatGPT conversation page
   - Visual indicator when conversation is captured
   - One-click download as JSON

3. **Data Processing**
   - Extract conversation metadata (title, create_time, update_time)
   - Preserve full message tree structure
   - Include all message content and metadata

4. **File Management**
   - Save as `{conversation_title}_{timestamp}.json`
   - Sanitize filename (remove special chars)
   - Use browser's download API

## Implementation Details

### Background Script (background.ts)
```typescript
export default defineBackground(() => {
  // Listen for web requests
  chrome.webRequest.onCompleted.addListener(
    async (details) => {
      if (details.url.includes('backend-api/conversation/')) {
        // Extract conversation ID
        const conversationId = extractConversationId(details.url);
        
        // Fetch the conversation data
        const response = await fetch(details.url);
        const data = await response.json();
        
        // Store temporarily for content script
        await chrome.storage.local.set({
          [`conversation_${conversationId}`]: data
        });
        
        // Notify content script
        chrome.tabs.sendMessage(details.tabId!, {
          type: 'CONVERSATION_CAPTURED',
          conversationId
        });
      }
    },
    { urls: ['https://chatgpt.com/backend-api/conversation/*'] }
  );
});
```

### Content Script (chatgpt.ts)
```typescript
export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  main() {
    // Add save button to UI
    injectSaveButton();
    
    // Listen for capture events
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'CONVERSATION_CAPTURED') {
        handleConversationCapture(message.conversationId);
      }
    });
  }
});

function injectSaveButton() {
  const button = document.createElement('button');
  button.textContent = 'Save Conversation';
  button.onclick = async () => {
    const conversationId = getCurrentConversationId();
    await downloadConversation(conversationId);
  };
  // Append to appropriate location in DOM
}
```

## Configuration Files

### package.json
```json
{
  "name": "llm-response-capture",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "check": "biome check --write .",
    "lint": "biome lint .",
    "format": "biome format --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "^2.3.11",
    "wxt": "^0.20.13"
  }
}
```

### biome.json
```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.11/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingComma": "es5",
      "semicolons": "always"
    }
  },
  "organizeImports": {
    "enabled": true
  }
}
```

### wxt.config.ts
```typescript
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'LLM Response Capture',
    description: 'Capture and save conversations from ChatGPT, Gemini, and other LLMs',
    permissions: [
      'storage',
      'downloads',
      'webRequest'
    ],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://gemini.google.com/*'
    ]
  },
  modules: ['@wxt-dev/module-react'] // Optional: if using React
});
```

## Development Workflow

### Setup
```bash
# Install Bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# Create new WXT project
bunx wxt@latest init llm-response-capture

# Navigate to project
cd llm-response-capture

# Install dependencies
bun install

# Add Biome
bun add -d @biomejs/biome

# Initialize Biome
bunx @biomejs/biome init
```

### Development
```bash
# Start dev server with HMR
bun run dev

# Format code
bun run format

# Lint code
bun run lint

# Build for production
bun run build

# Create ZIP for Chrome Web Store
bun run zip
```

## Extensibility Design

### Platform Adapters
Create a base interface for platform-specific implementations:

```typescript
// utils/types.ts
export interface LLMPlatform {
  name: string;
  apiEndpoint: RegExp;
  extractConversationId: (url: string) => string;
  parseResponse: (data: any) => ConversationData;
  injectUI: () => void;
}

// platforms/chatgpt.ts
export const ChatGPTAdapter: LLMPlatform = {
  name: 'ChatGPT',
  apiEndpoint: /backend-api\/conversation\/.+/,
  extractConversationId: (url) => { /* ... */ },
  parseResponse: (data) => { /* ... */ },
  injectUI: () => { /* ... */ }
};
```

This allows easy addition of new platforms (Gemini, Grok, Claude) by implementing the same interface.

## Next Steps

1. **Phase 1**: Implement ChatGPT support
2. **Phase 2**: Add Gemini support
3. **Phase 3**: Add Grok support
4. **Phase 4**: Settings UI for customization
5. **Phase 5**: Export formats (JSON, Markdown, HTML)

## Performance Considerations

- WXT's Vite-based HMR enables instant development feedback
- Biome (Rust) lints/formats 10-20x faster than ESLint/Prettier
- Bun installs packages 20-40x faster than npm
- Minimal UI framework usage keeps extension lightweight
- Use `chrome.storage.local` efficiently (5MB limit)

## Resources

- [WXT Documentation](https://wxt.dev)
- [Biome Documentation](https://biomejs.dev)
- [Bun Documentation](https://bun.sh)
- [Chrome Extension API](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/develop/migrate)
