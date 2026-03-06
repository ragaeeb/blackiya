<p align="center">
  <img src="public/icon/128.png" width="128" alt="Blackiya Logo" />
</p>

# Blackiya

[![wakatime](https://wakatime.com/badge/user/a0b906ce-b8e7-4463-8bce-383238df6d4b/project/c697711b-e0aa-47e9-96bd-1ec21e640d07.svg)](https://wakatime.com/badge/user/a0b906ce-b8e7-4463-8bce-383238df6d4b/project/c697711b-e0aa-47e9-96bd-1ec21e640d07)
[![codecov](https://codecov.io/gh/ragaeeb/blackiya/graph/badge.svg?token=M52GQARSGD)](https://codecov.io/gh/ragaeeb/blackiya)
[![Node.js CI](https://github.com/ragaeeb/blackiya/actions/workflows/build.yml/badge.svg)](https://github.com/ragaeeb/blackiya/actions/workflows/build.yml)
[![Version](https://img.shields.io/github/v/release/ragaeeb/blackiya)](https://github.com/ragaeeb/blackiya/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=flat&logo=bun&logoColor=white)](https://bun.sh)
[![Biome](https://img.shields.io/badge/Biome-%2360a5fa.svg?style=flat&logo=biome&logoColor=white)](https://biomejs.dev)
[![WXT](https://img.shields.io/badge/WXT-%235d2fbf.svg?style=flat&logo=wxt&logoColor=white)](https://wxt.dev)

A high-performance Chrome extension for capturing and saving conversation JSON from popular LLM platforms (ChatGPT, Gemini, Grok).

## 📚 Architecture Docs

- Architecture source of truth: `docs/architecture.md`
- Debug logs guide: `docs/debug-logs-guide.md`
- Discovery mode guide: `docs/discovery-mode.md`
- Current PR summary (this branch): `docs/PR.md`

## 🔎 HAR Discovery Triage

When platform network behavior drifts (new endpoints, changed payloads), run HAR analysis on a DevTools export:

```bash
bun run har:analyze --input logs/grok.com.har --host grok.com --hint "Agents thinking"
```

Outputs are written to `logs/har-analysis/` by default:
- `*.analysis.json` for machine/agent workflows
- `*.analysis.md` for human triage

See related docs:
- `docs/discovery-mode.md` for end-to-end discovery workflow
- `docs/debug-logs-guide.md` for artifact selection and log interpretation

## 📦 Available Scripts

```bash
# Development
bun run dev              # Start dev server with HMR (animal build names enabled)

# Code Quality
bun run check            # Lint and format code (auto-fix)
bun run lint             # Run Biome linter
bun run format           # Format code with Biome

# Building
bun run build            # Build for production (stable extension name: "Blackiya")
bun run zip              # Create distributable ZIP file

# Testing
bun test                 # Run tests (when added)
bun run test:e2e         # Run Playwright smoke harness (requires BLACKIYA_EXTENSION_PATH)
bun test utils/har-analysis.integration.test.ts
```

Playwright smoke usage:
```bash
BLACKIYA_EXTENSION_PATH="$(pwd)/dist/chrome-mv3" bun run test:e2e
```

## 🏗️ Project Structure

```text
blackiya/
├── dist/                    # Build output (git-ignored)
│   └── chrome-mv3/            # Chrome extension build
├── entrypoints/
│   ├── background.ts          # Service worker for API interception
│   ├── main.content.ts        # Unified content script for all LLMs
│   ├── interceptor.content.ts # Thin MAIN-world entrypoint
│   ├── interceptor/
│   │   ├── bootstrap.ts       # MAIN-world interceptor implementation
│   │   ├── bootstrap-main-bridge.ts
│   │   ├── attempt-registry.ts
│   │   ├── fetch-pipeline.ts
│   │   ├── xhr-pipeline.ts
│   │   ├── state.ts
│   │   ├── signal-emitter.ts
│   │   ├── discovery.ts
│   │   ├── fetch-wrapper.ts
│   │   ├── xhr-wrapper.ts
│   │   ├── proactive-fetcher.ts
│   │   └── stream-monitors/
│   │       ├── chatgpt-sse-monitor.ts
│   │       ├── gemini-stream-monitor.ts
│   │       └── grok-stream-monitor.ts
│   └── popup/
│       ├── index.html        # Extension popup UI (optional)
│       └── App.tsx           # Popup logic (optional)
├── platforms/
│   ├── chatgpt/              # ChatGPT adapter + parsing/readiness modules
│   ├── gemini/               # Gemini adapter + RPC/title/conversation modules
│   ├── grok/                 # Grok adapter + NDJSON/GraphQL/title modules
│   ├── constants.ts
│   ├── factory.ts            # Adapter factory
│   └── types.ts              # Platform interface definitions
├── utils/
│   ├── runner/
│   │   ├── engine/                    # Core runner engine, context, SFE wrappers, emission
│   │   ├── runtime/                   # Runtime bootstrapping, wiring, cleanup, settings
│   │   ├── stream/                    # Stream probe UI/runtime/coordinator helpers
│   │   ├── attempt-registry.ts
│   │   ├── calibration-policy.ts
│   │   ├── canonical-stabilization.ts
│   │   ├── export-pipeline.ts
│   │   ├── readiness.ts
│   │   └── state.ts
│   ├── external-api/          # Extension-to-extension API contracts + hub
│   ├── managers/             # Interception/navigation managers
│   ├── sfe/                  # Signal Fusion Engine
│   ├── download.ts           # File download utilities
│   ├── protocol/             # Cross-world message protocol
│   ├── minimal-logs.ts       # Debug report generator
│   └── logger.ts             # Runtime logging utilities
├── docs/
│   ├── architecture.md
│   ├── PR.md
│   ├── debug-logs-guide.md
│   └── discovery-mode.md
├── public/
│   └── icon/                 # Extension icons
│       ├── 16.png
│       ├── 48.png
│       └── 128.png
├── .gitignore
├── biome.json                # Biome configuration
├── bun.lock                  # Bun lock file
├── package.json              # Project dependencies
├── tsconfig.json             # TypeScript configuration
├── wxt.config.ts             # WXT framework configuration
├── AGENTS.md                 # AI agent documentation
└── README.md                 # This file
```

## 🎯 Features

- ✅ **Full Capture**: Capture complete conversation JSON from ChatGPT, Gemini, and Grok.
- ✅ **Gemini Advanced**: Support for Gemini's `batchexecute` protocol, including **Thinking/Reasoning logs**.
- ✅ **Grok Support**: Full support for Grok's GraphQL API, including conversation history and thinking traces.
- ✅ **Smart Titles**: Automatic conversation title capture (with retroactive updates for async title loads).
- ✅ **One-Click Download**: Instant download as formatted JSON file.
- ✅ **Clipboard Copy**: One-click copy of conversation JSON directly to system clipboard.
- ✅ **About Section**: Dynamic extension metadata (version, author) synchronized from `package.json`.
- ✅ **Automatic Naming**: Filenames generated from conversation titles and timestamps.
- ✅ **Robust UI**: Seamless button injection into ChatGPT, Gemini, and Grok interfaces.
- ✅ **Message Tree**: Preserves complete nested message structure.
- ✅ **Extensive Testing**: Large regression-focused unit/integration test suite for adapters and runtime orchestration.
- ✅ **Absolute Imports**: Cleaner codebase using `@/` path aliases.
- ✅ **Automated Releases**: CI/CD pipeline with Semantic Versioning and automated GitHub Releases.
- ✅ **Advanced Logging**: Structured, exportable debug logs with privacy-focused persistent storage.

## 🔧 Configuration

### Manifest V3 Permissions

The extension requires the following permissions:

- **`storage`** - Save user preferences and temporary data
- **`webRequest`** - Intercept API requests (optional, for auto-capture)

### Host Permissions

- `https://chatgpt.com/*` - ChatGPT platform
- `https://chat.openai.com/*` - Legacy ChatGPT platform
- `https://gemini.google.com/*` - Gemini platform
- `https://grok.com/*` - Grok platform

### External Extension API

External extension messaging is currently disabled and not part of the shipped runtime flow.

## 🔒 Privacy & Compliance

### Single Purpose
Blackiya has a single, narrow purpose: to provide users with a tool to capture and export their conversation data from specific AI platforms (ChatGPT, Gemini, and Grok) as JSON files for personal archiving and analysis.

### Remote Code Disclosure
- **No Remote Code:** Blackiya does NOT use any remote code. All logic (JavaScript and Wasm) is included directly in the extension's package. We do not use external `<script>` tags, external modules, or `eval()` for executing remote strings.

### Data Usage & Collection
In accordance with the Chrome Web Store Developer Program Policies, we declare the following regarding data collection:

| Data Category | Status | Justification |
| :--- | :--- | :--- |
| **Personally identifiable information** | ❌ Not Collected | None required for functionality. |
| **Health information** | ❌ Not Collected | None required for functionality. |
| **Financial and payment information** | ❌ Not Collected | No payments or financial processing within the extension. |
| **Authentication information** | ❌ Not Collected | No passwords or credentials are stored or transmitted. |
| **Personal communications** | ❌ Not Collected | Conversations are processed locally and only exported at the user's request. |
| **Location** | ❌ Not Collected | No GPS or IP-based location tracking. |
| **Web history** | ❌ Not Collected | We do not track browsing history outside of the supported AI platforms. |
| **User activity** | ❌ Not Collected | No network monitoring or keystroke logging. |
| **Website content** | ❌ Not Collected | Content is only read from supported platforms to facilitate the export feature. |

*All processed data remains strictly local to the user's device.*

### Privacy Policy
For the full legal disclosure, please refer to our [Privacy Policy](./PRIVACY_POLICY.md).

## 🧪 Development Workflow

### Making Changes

1. Edit source files in `entrypoints/`, `utils/`, or `platforms/`
2. Save the file
3. WXT will automatically rebuild (watch mode)
4. Reload the extension in Chrome if needed (background script changes)
5. Refresh the target webpage (content script changes)

### Adding a New Platform

1. Create a platform folder and adapter entrypoint at `platforms/your-platform/index.ts`
2. Implement the `LLMPlatform` interface
3. Register adapter in `platforms/factory.ts`
4. Add host URL pattern in `platforms/constants.ts`
5. Update `wxt.config.ts` host permissions if needed
6. Add parser/readiness tests under `platforms/your-platform/*.test.ts`

### Code Quality

Before committing:

```bash
# Format and lint all files
bun run check

# Or separately
bun run format  # Format code
bun run lint    # Check for issues
```

### Building for Production

```bash
# Create optimized build
bun run build

# Create ZIP for Chrome Web Store submission
bun run zip
```

The ZIP file will be in `dist/` directory.

Build naming behavior:
- `bun run dev` uses a per-build animal codename in the extension display name (for easy stale-build detection).
- `bun run build` uses the stable production display name (`Blackiya`) without animal codenames.

## 📝 Usage

### Basic Usage

1. Navigate to ChatGPT, Gemini, or Grok and open a conversation
2. The conversation JSON will download or be copied automatically.
3. Download format: `{conversation-title}_{timestamp}.json`

### Popup Tools

From the extension popup you can:
1. Set log level (`Debug`, `Info`, `Warn`, `Error`)
2. Run `Export Chats` from the active platform tab (`Max chats`, where `0 = all`; default `0`; pacing uses fixed internal delay/timeout)
3. Export full logs JSON
4. Export a token-lean debug report TXT
5. Clear logs

### Viewing Saved Conversations

The JSON file contains:
- Full conversation metadata (title, timestamps)
- Complete message tree structure
- All message content and metadata
- Model information
- Plugin IDs (if any)

### Exporting Debug Logs

1. Click the extension icon to open the Popup UI.
2. View current log count and adjust the **Log Level** (Debug/Info/Warn/Error).
3. Click **Export Full Logs (JSON)** to download the raw extension log buffer.
4. Click **Export Debug Report (TXT)** for a token-lean troubleshooting summary.

Debugging references:
- `docs/debug-logs-guide.md`
- `docs/discovery-mode.md`

For bottom-left stream/probe toast meanings (`stream-done:*`, canonical vs degraded states), see `docs/debug-logs-guide.md` section **Bottom-Left Toast / Probe Panel Statuses**.

## 🤝 Contributing

### Setup for Contributors

1. Fork the repository
2. Clone your fork: `git clone <your-fork-url>`
3. Create a branch: `git checkout -b feature/your-feature`
4. Make changes and commit
5. Run code quality checks: `bun run check`
6. Push and create Pull Request

### Commit Guidelines

We follow **Semantic Versioning** rules. The extension version is automatically bumped based on your commit messages.

Use **[Conventional Commits](https://www.conventionalcommits.org/)**:

- **`feat:`** -> **Minor** version bump (e.g., `1.1.0` -> `1.2.0`)
  - Example: `feat: add grok platform support`
- **`fix:`** -> **Patch** version bump (e.g., `1.1.0` -> `1.1.1`)
  - Example: `fix: resolve button injection timing issue`
- **`BREAKING CHANGE:`** -> **Major** version bump (e.g., `1.1.0` -> `2.0.0`)
  - Example in footer: `BREAKING CHANGE: api structure has completely changed`
- **`docs:`, `chore:`, `refactor:`, `test:`** -> **No** version bump (unless specified otherwise)
  - Example: `docs: update README with troubleshooting`

> **Note:** Pull Requests must be squashed or use these conventions in the merge commit message to trigger the release workflow properly.

## 🔗 Resources

- [WXT Documentation](https://wxt.dev)
- [Chrome Extension API](https://developer.chrome.com/docs/extensions/)
- [Biome Documentation](https://biomejs.dev)
- [Bun Documentation](https://bun.sh)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
