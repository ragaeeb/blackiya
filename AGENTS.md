# AGENTS.md - AI Agent Documentation

> **Purpose:** This document provides AI coding agents (Claude, GPT, Cursor, etc.) with comprehensive context about the project's architecture, design patterns, and development guidelines.

## 🎯 Project Intent

**Blackiya** is a Chrome browser extension designed to capture and save conversation JSON data from popular Large Language Model platforms (ChatGPT, Gemini, Grok, Claude, etc.).

### Core Objectives

1. **Capture** - Intercept and extract conversation data from LLM web interfaces
2. **Save** - Download conversation JSON to local filesystem
3. **Extensibility** - Support multiple LLM platforms via adapter pattern
4. **Performance** - Minimal overhead, fast builds, instant HMR
5. **Simplicity** - No unnecessary UI frameworks; utility-focused

### Non-Goals

- ❌ Real-time conversation syncing
- ❌ Cloud storage integration (Phase 7+)
- ❌ Complex UI/visualization of conversations
- ❌ Conversation editing or modification
- ❌ Multi-browser support (Chrome/Chromium only for now)

## 🏛️ Architecture Overview

### High-Level Architecture

```text
┌─────────────────────────────────────────────────────────┐
│                    Browser Tab (ChatGPT)                │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Content Script (chatgpt.ts)                       │ │
│  │  - Injects "Save" button into page DOM             │ │
│  │  - Listens for user clicks                         │ │
│  │  - Communicates with Background Script             │ │
│  └────────────────┬───────────────────────────────────┘ │
└───────────────────┼─────────────────────────────────────┘
                    │ chrome.runtime.sendMessage()
                    ▼
┌─────────────────────────────────────────────────────────┐
│       Background Service Worker (background.ts)         │
│  - Intercepts network requests (optional)               │
│  - Fetches conversation data from API                   │
│  - Processes and stores data temporarily                │
│  - Triggers download via chrome.downloads API           │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│              Platform Adapters (platforms/)             │
│  - ChatGPT: API endpoint, parsing, UI injection         │
│  - Gemini: API endpoint, parsing, UI injection          │
│  - Grok: API endpoint, parsing, UI injection            │
│  (Each implements LLMPlatform interface)                │
└─────────────────────────────────────────────────────────┘
```

### Component Breakdown

#### 1. Background Service Worker (`entrypoints/background.ts`)

**Responsibilities:**
- **API Interception** - Monitor network requests to LLM APIs
- **Data Fetching** - Retrieve conversation JSON from endpoints
- **Message Handling** - Respond to content script requests
- **Download Management** - Trigger file downloads via Chrome API

**Key Functions:**
```typescript
- interceptAPIRequests() // Optional: webRequest API
- fetchConversationData(conversationId: string)
- handleMessage(message: Message, sender: MessageSender)
- downloadJSON(data: ConversationData, filename: string)
```

**Communication:**
- Listens: `chrome.runtime.onMessage`
- Sends: `chrome.tabs.sendMessage()`
- Storage: `chrome.storage.local`

#### 2. Content Scripts (`entrypoints/content/*.ts`)

**Responsibilities:**
- **UI Injection** - Add "Save Conversation" button to page
- **DOM Observation** - Detect page changes (SPA navigation)
- **User Interaction** - Handle button clicks
- **Data Extraction** - Get conversation ID from URL/DOM

**Key Functions:**
```typescript
- injectSaveButton() // Add button to specific DOM location
- observePageChanges() // MutationObserver for SPA navigation
- handleSaveClick() // User interaction handler
- getCurrentConversationId() // Extract ID from page
```

**Platform-Specific:**
- `chatgpt.ts` - ChatGPT-specific selectors and logic
- `gemini.ts` - Gemini-specific selectors and logic
- `grok.ts` - Grok-specific selectors and logic

#### 3. Platform Adapters (`platforms/*.ts`)

**Responsibilities:**
- **API Configuration** - Define endpoints and patterns
- **Data Parsing** - Transform platform-specific JSON
- **URL Handling** - Extract conversation IDs
- **UI Specifications** - Define where/how to inject buttons

**Interface Definition:**
```typescript
export interface LLMPlatform {
  name: string;                    // Platform name (e.g., "ChatGPT")
  urlMatchPattern: string;         // URL pattern for content script matching
  apiEndpointPattern: RegExp;      // Regex for API endpoint detection
  extractConversationId: (url: string) => string | null;
  parseInterceptedData: (data: any, url: string) => ConversationData | null;
  buildApiUrl?: (conversationId: string) => string;
  getButtonInjectionTarget: () => HTMLElement | null;
  formatFilename: (data: ConversationData) => string;
}
```

**Example Implementation:**
```typescript
// platforms/chatgpt.ts
export const chatGPTAdapter: LLMPlatform = {
  name: 'ChatGPT',
  urlMatchPattern: 'https://chatgpt.com/*',
  apiEndpointPattern: /backend-api\/conversation\/[a-f0-9-]+$/,
  
  extractConversationId: (url) => {
    // Implementation using URL object and strict validation
    // Returns string | null
  },
  
  parseInterceptedData: (data, url) => {
    // Returns ConversationData | null
  },
  
  formatFilename: (data) => {
    // Returns sanitized filename string
  },
  
  getButtonInjectionTarget: () => {
    // Returns HTMLElement | null
  }
};

// platforms/gemini.ts
export const geminiAdapter: LLMPlatform = {
  name: 'Gemini',
  urlMatchPattern: 'https://gemini.google.com/*',
  apiEndpointPattern: /BardChatUi\/data\/batchexecute.*rpcids=.*hNvQHb/,
  
  extractConversationId: (url) => {
    // Extracts hex ID from URL: gemini.google.com/app/{id}
  },
  
  parseInterceptedData: (data, url) => {
    // 1. Strips magic header: )]}'
    // 2. Parses double-JSON-encoded batchexecute response
    // 3. Normalizes conversation ID (stripping 'c_' prefix)
    // 4. Reconstructs ConversationData from nested message payload
  },
  
  formatFilename: (data) => {
    // Returns sanitized filename string
  },
  
  getButtonInjectionTarget: () => {
    // Returns header navigation for button injection
  }
};
```

#### 4. Utility Modules (`utils/*.ts`)

**`utils/storage.ts`** - Chrome storage wrapper
```typescript
export async function saveToStorage(key: string, value: any): Promise<void>
export async function getFromStorage<T>(key: string): Promise<T | null>
export async function removeFromStorage(key: string): Promise<void>
export async function clearStorage(): Promise<void>
```

**`utils/capture.ts`** - Core capture logic
```typescript
export async function captureConversation(conversationId: string): Promise<ConversationData>
export function sanitizeFilename(filename: string): string
export function generateTimestamp(): string
```

**`utils/download.ts`** - Download utilities
```typescript
export async function downloadJSON(data: any, filename: string): Promise<void>
export function createBlobURL(data: any): string
export function revokeBlobURL(url: string): void
```

**`utils/types.ts`** - TypeScript definitions
```typescript
export interface ConversationData {
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, MessageNode>;
  // ... other fields
}

export interface MessageNode {
  id: string;
  message: Message | null;
  parent: string | null;
  children: string[];
}

export interface Message {
  id: string;
  author: Author;
  content: Content;
  create_time: number | null;
  // ... other fields
}
```

## 🔧 Tech Stack

### Core Framework
- **WXT v0.20.13** - Next-gen browser extension framework
  - File-based routing for entrypoints
  - Vite-powered for fast HMR
  - Auto-manifest generation
  - TypeScript-first

### Package Manager
- **Bun v1.3+** - Fast JavaScript runtime & package manager
  - 20-40x faster than npm
  - Native TypeScript support
  - Built-in test runner

### Code Quality
- **Biome v2.3.11** - Fast linter & formatter (Rust-based)
  - Replaces ESLint + Prettier
  - 340+ lint rules
  - <1s linting for typical projects

### Language
- **TypeScript 5.x** - Type-safe JavaScript
  - Strict mode enabled
  - ES2022 target
  - Path aliases configured

### Browser APIs
- **Chrome Extensions API (Manifest V3)**
  - `chrome.runtime` - Message passing
  - `chrome.storage` - Local storage
  - `chrome.downloads` - File downloads
  - `chrome.tabs` - Tab management
  - `chrome.webRequest` - Network interception (optional)

## 📐 Design Patterns

### 1. **Adapter Pattern** (Platform Abstraction)

**Purpose:** Support multiple LLM platforms without code duplication

**Implementation:**
```typescript
// Define common interface
interface LLMPlatform { /* ... */ }

// Implement platform-specific adapters
class ChatGPTAdapter implements LLMPlatform { /* ... */ }
class GeminiAdapter implements LLMPlatform { /* ... */ }

// Use polymorphically
function captureFromPlatform(adapter: LLMPlatform) {
  const id = adapter.extractConversationId(window.location.href);
  const data = adapter.parseResponse(rawData);
  // ... common logic
}
```

**Benefits:**
- Add new platforms by implementing interface
- Shared core logic in utils/
- Easy testing (mock adapters)

### 2. **Message Passing** (Component Communication)

**Purpose:** Content scripts and background workers communicate

**Pattern:**
```typescript
// Content Script → Background
chrome.runtime.sendMessage({
  type: 'CAPTURE_CONVERSATION',
  conversationId: '123'
});

// Background → Content Script
chrome.tabs.sendMessage(tabId, {
  type: 'CONVERSATION_READY',
  data: conversationData
});
```

**Message Types:**
- `CAPTURE_CONVERSATION` - Request to capture
- `CONVERSATION_READY` - Data ready for download
- `ERROR` - Error occurred
- `UPDATE_UI` - Update button state

### 3. **Factory Pattern** (Platform Selection)

**Purpose:** Dynamically select appropriate platform adapter

```typescript
// platforms/factory.ts
export function getPlatformAdapter(url: string): LLMPlatform | null {
  if (url.includes('chatgpt.com')) return ChatGPTAdapter;
  if (url.includes('gemini.google.com')) return GeminiAdapter;
  if (url.includes('x.com')) return GrokAdapter;
  return null;
}
```

### 4. **Observer Pattern** (DOM Changes)

**Purpose:** React to SPA navigation without page reloads

```typescript
const observer = new MutationObserver((mutations) => {
  if (conversationChanged(mutations)) {
    reinjectButton();
  }
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});
```

## 📂 Folder Structure & Conventions

### Directory Organization

```text
blackiya/
├── entrypoints/          # WXT entrypoints (auto-detected)
│   ├── background.ts          # Service worker (SINGLETON)
│   ├── main.content.ts        # Unified content script for all LLMs
│   ├── interceptor.content.ts # Fetch interceptor (MAIN world)
│   └── popup/                 # Extension popup (OPTIONAL)
│       ├── index.html
│       └── App.tsx
├── platforms/            # Platform adapters (CORE LOGIC)
│   ├── chatgpt.ts        # ChatGPT adapter implementation
│   ├── gemini.ts         # Gemini adapter implementation
│   ├── grok.ts           # Grok adapter implementation
│   └── types.ts          # LLMPlatform interface
├── utils/                # Shared utilities (FRAMEWORK-AGNOSTIC)
│   ├── storage.ts        # Chrome storage wrapper
│   ├── capture.ts        # Core capture logic
│   ├── download.ts       # File download helpers
│   └── types.ts          # TypeScript interfaces
├── public/               # Static assets
│   └── icon/             # Extension icons (16, 48, 128)
└── [config files]        # wxt.config.ts, biome.json, etc.
```

### Naming Conventions

**Files:**
- `kebab-case.ts` for all files
- `PascalCase` for classes/interfaces
- `camelCase` for functions/variables

**Exports:**
- Named exports for utilities: `export function captureConversation()`
- Default exports for adapters: `export default ChatGPTAdapter`

**Constants:**
- `UPPER_SNAKE_CASE` for constants: `const API_ENDPOINT = '...'`

### File Headers

Add JSDoc comments to all major files:

```typescript
/**
 * ChatGPT Platform Adapter
 * 
 * Handles conversation capture from ChatGPT platform.
 * Implements LLMPlatform interface for standardized interaction.
 * 
 * @module platforms/chatgpt
 */
```

## 🔄 Development Workflow for AI Agents

### When Adding a New Feature

1. **Identify Component** - Determine which layer (background, content, platform, util)
2. **Check Interface** - Verify if existing interfaces need extension
3. **Implement** - Add feature following patterns above
4. **Update Types** - Add TypeScript types in `utils/types.ts`
5. **Test** - Run `bun run dev` and manually test
6. **Lint** - Run `bun run check` before committing

### When Adding a New Platform

**Step-by-step:**

1. Create adapter: `platforms/new-platform.ts`
   ```typescript
   export const NewPlatformAdapter: LLMPlatform = {
     name: 'NewPlatform',
     apiEndpoint: /api-pattern/,
     extractConversationId: (url) => { /* ... */ },
     parseResponse: (data) => { /* ... */ },
     getButtonInjectionTarget: () => { /* ... */ },
     formatFilename: (data) => { /* ... */ }
   };
   ```

2. Update `entrypoints/main.content.ts` matches:
   ```typescript
   matches: [
     'https://chatgpt.com/*',
     'https://newplatform.com/*'  // ADD THIS
   ]
   ```

3. Update `wxt.config.ts` host permissions:
   ```typescript
   host_permissions: [
     'https://chatgpt.com/*',
     'https://newplatform.com/*'  // ADD THIS
   ]
   ```

4. Test in dev mode: `bun run dev`

### When Debugging

**Common Issues:**

1. **Button not appearing** → Check DOM selectors in content script
2. **API not intercepted** → Verify URL patterns in background script
3. **Download fails** → Check Chrome permissions in manifest
4. **Build errors** → Clear `.output/` and rebuild

**Debug Tools:**

- Chrome DevTools (Console, Network, Sources)
- `chrome://extensions/` → Inspect views → background page
- `console.log()` in content scripts → Page console
- `console.log()` in background → Service worker console

## 🧪 Testing Guidelines

### Manual Testing Checklist

For each platform:

- [ ] Button injects correctly on page load
- [ ] Button appears after SPA navigation
- [ ] Click triggers conversation capture
- [ ] JSON downloads with correct filename
- [ ] Downloaded JSON is valid and complete
- [ ] Works on empty conversations
- [ ] Works on long conversations (>100 messages)

### Automated Testing (Future)

```typescript
// Example test structure (using Bun test runner)
import { test, expect } from 'bun:test';
import { ChatGPTAdapter } from './platforms/chatgpt';

test('ChatGPT adapter extracts conversation ID', () => {
  const url = 'https://chatgpt.com/c/abc-123-def';
  const id = ChatGPTAdapter.extractConversationId(url);
  expect(id).toBe('abc-123-def');
});
```

## 📝 Code Style Guidelines

### TypeScript Best Practices

**Use explicit types:**
```typescript
// ✅ Good
function captureConversation(id: string): Promise<ConversationData> { }

// ❌ Avoid
function captureConversation(id: any): any { }
```

**Prefer interfaces over types:**
```typescript
// ✅ Good
interface ConversationData { }

// ❌ Avoid (unless union/intersection needed)
type ConversationData = { }
```

**Use async/await over promises:**
```typescript
// ✅ Good
async function fetchData() {
  const response = await fetch(url);
  return await response.json();
}

// ❌ Avoid
function fetchData() {
  return fetch(url).then(r => r.json());
}
```

### Biome Configuration

Project uses Biome for linting/formatting:

- **Indent:** 4 spaces
- **Quotes:** Single quotes (`'`)
- **Semicolons:** Always (`;`)
- **Line width:** 120 characters
- **Trailing commas:** all

Run before committing:
```bash
bun run check  # Auto-fix all issues
```

### Comments

**JSDoc for public APIs:**
```typescript
/**
 * Downloads conversation data as JSON file
 * @param data - Conversation data to download
 * @param filename - Name of the file (without extension)
 * @throws {Error} If download fails
 */
export async function downloadJSON(data: ConversationData, filename: string) { }
```

**Inline comments for complex logic:**
```typescript
// Extract conversation ID from URL path segment
// Format: /c/{conversation-id} or /conversation/{conversation-id}
const id = url.split('/').find(segment => segment.match(/^[a-f0-9-]{36}$/));
```

## 🚨 Important Constraints

### Chrome Extension Limitations

1. **Manifest V3 Required**
   - Service workers instead of background pages
   - Limited storage (5MB for `chrome.storage.local`)
   - No `eval()` or inline scripts

2. **Content Script Isolation**
   - Cannot access page JavaScript directly
   - Must use `window.postMessage()` for page script communication
   - DOM manipulation only

3. **Background Script Persistence**
   - Service workers terminate after inactivity
   - State must be saved to `chrome.storage`
   - Event-driven architecture only

### Platform-Specific Constraints

**ChatGPT:**
- API endpoint: `https://chatgpt.com/backend-api/conversation/{id}`
- Authentication: Session cookies (handled by browser)
- Rate limiting: Unknown (be respectful)

**Gemini:**
- API protocol: `batchexecute` (POST request with `f.req` parameter)
- RPC ID: `hNvQHb` (primary ID for conversation data fetch)
- Response format: Obfuscated JSON array with security prefix `)]}'\n\n`
- Data structure: Double-JSON encoded payload at `payload[0][0][0]`
- ID normalization: Payload IDs prefixed with `c_` are normalized (prefix removed) to match URL IDs.

## 🎓 Learning Resources

For AI agents unfamiliar with concepts:

- **WXT Framework:** [WXT Guide](https://wxt.dev/guide/)
- **Chrome Extensions:** [Chrome Extensions MV3](https://developer.chrome.com/docs/extensions/mv3/)
- **Manifest V3 Migration:** [Migration Guide](https://developer.chrome.com/docs/extensions/migrating/)
- **Content Scripts:** [Content Scripts](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)
- **Message Passing:** [Message Passing](https://developer.chrome.com/docs/extensions/mv3/messaging/)

## 📋 Quick Reference

### Key Commands

```bash
bun install          # Install dependencies
bun run dev          # Start development server
bun run build        # Production build
bun run check        # Lint & format (auto-fix)
```

### Important Files

- `wxt.config.ts` - Extension manifest configuration
- `biome.json` - Linting/formatting rules
- `utils/types.ts` - Shared TypeScript types
- `platforms/types.ts` - Platform interface definitions

### Chrome APIs to Use

- `chrome.runtime.sendMessage()` - Send messages
- `chrome.runtime.onMessage.addListener()` - Receive messages
- `chrome.storage.local.get/set()` - Persist data
- `chrome.downloads.download()` - Download files
- `chrome.tabs.query()` - Get active tab

---

**Last Updated:** 2026-01-17  
**Agent Version:** 1.0.0  
**For:** Claude, GPT-4, Cursor, and other AI coding agents