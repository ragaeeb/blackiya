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

A high-performance Chrome extension for exporting conversation JSON from ChatGPT, Gemini, and Grok — as verbatim terminal archives, on demand.

## 📚 Architecture Docs

- Architecture source of truth: `docs/architecture.md`
- Debug logs guide: `docs/debug-logs-guide.md`

## 🎯 Features

- ✅ **Single-Chat Ready-Terminal Export**: An explicit `Save JSON` control resolves the adapter's deterministic detail-request candidates, validates the server response is ready and terminal, and downloads the complete JSON archive (full message tree, reasoning data preserved verbatim). ChatGPT advances to its fallback candidate only after a `404`.
- ✅ **Fail-Fast**: Every non-happy path returns a typed error — no retries, no degraded/partial export, no silent data loss. A failed export tells you exactly which gate rejected it (`missing_auth`, `id_mismatch`, `not_terminal`, `download_failure`, `timeout`, …).
- ✅ **Bulk `Export Chats`**: From the popup, export a list of conversations from the active platform tab (`Max chats`, where `0 = all`). Each detail payload must match its requested id and be ready-terminal before download; requests use pacing, per-request timeout, and bounded `429` retry handling.
- ✅ **Stream-Debug Capture**: Raw ordered stream frames (SSE/NDJSON/raw) are recorded in memory, bounded, sanitized, and exported or cleared explicitly — never written into conversation JSON.
- ✅ **Request-Context Without Credential Persistence**: Platform auth headers and Gemini batchexecute context are resolved in memory at export time, expire from page-local stores, and are never written into exports.
- ✅ **Smart Titles**: Automatic conversation title resolution and export-time filename generation.
- ✅ **Popup Controls**: Bulk export, stream-debug export, and stream-debug clearing in one place.
- ✅ **Message Tree**: Preserves the complete nested message structure (the `mapping` tree) verbatim.
- ✅ **Extensive Testing**: Regression-focused unit/integration coverage for adapters, single-export, bulk-export, and stream-debug.
- ✅ **Automated Releases**: CI/CD pipeline with Semantic Versioning and automated GitHub Releases.

## 🔒 Privacy & Compliance

- **Local-first and explicit.** Export happens only when you click `Save JSON` or `Export Chats`; nothing is uploaded.
- **No credential persistence.** Request-context is captured in page-local memory with a short expiry and never written into exports.
- See [`docs/architecture.md`](docs/architecture.md) and [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md).

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
bun test                 # Run unit/integration tests
bun run test:e2e         # Run Playwright smoke harness
bun run compile          # Type-check
```

## 🏗️ Project Structure

```text
blackiya/
├── dist/                    # Build output (git-ignored)
│   └── chrome-mv3/            # Chrome extension build
├── entrypoints/
│   ├── main.content.ts        # v3 content runtime entry (bulk export + stream-debug bridge)
│   ├── interceptor.content.ts # Thin MAIN-world entrypoint (request-context + stream capture)
│   ├── interceptor/
│   │   └── bootstrap.ts       # MAIN-world interceptor implementation
│   └── popup/
│       ├── index.html         # Extension popup UI
│       └── App.tsx            # Popup logic (Export Chats, stream-debug tools)
├── features/
│   ├── runtime/               # v3 content runtime, message types, request-context bridges
│   ├── single-export/         # On-demand terminal single-chat export (fail-fast)
│   ├── bulk-export/           # Bulk Export Chats orchestrator + platform providers
│   ├── export-controls/       # Save JSON button (UI)
│   └── stream-debug/          # Ordered stream capture + explicit export/clear
├── platforms/
│   ├── chatgpt/               # ChatGPT adapter + parsing/readiness modules
│   ├── gemini/                # Gemini adapter + RPC/title/conversation modules
│   ├── grok/                  # Grok adapter + NDJSON/title modules
│   ├── constants.ts
│   ├── factory.ts             # Adapter factory
│   └── types.ts               # Platform interface definitions
├── utils/
│   ├── protocol/              # Cross-world message protocol + session token
│   ├── download.ts            # File download utilities
│   └── logger.ts              # Runtime logging utilities
├── docs/
│   ├── architecture.md
│   └── debug-logs-guide.md
├── public/
│   └── icon/                  # Extension icons
├── AGENTS.md                  # AI agent documentation
└── README.md                  # This file
```

## 🔧 Configuration

### Permissions

The extension requires the following host permissions:

- `https://chatgpt.com/*` — ChatGPT platform
- `https://chat.openai.com/*` — Legacy ChatGPT platform
- `https://gemini.google.com/*` — Gemini platform
- `https://grok.com/*` — Grok platform

`https://grok.x.com/*` is intentionally not listed. Grok streaming requests to `grok.x.com` are initiated by page JavaScript from the `grok.com` page context and are captured by the MAIN-world interceptor.

## 📝 Usage

### Single-Chat Export

1. Navigate to ChatGPT, Gemini, or Grok and open a conversation.
2. Click the **Save JSON** button (the `✓ Saved` state confirms the download).
3. The export resolves the adapter's deterministic detail candidates, validates the response is terminal, and downloads the complete JSON archive. ChatGPT accepts completed multimodal/image artifacts as terminal responses even when they contain no text. A candidate fallback is used only for a `404`; there are no retries or time-based recovery paths.

Downloads use `{conversation-title}_{timestamp}.json`.

The exported JSON is the full-fidelity source of truth: complete conversation metadata, the entire message tree (`mapping`), all message content and metadata, model information, and reasoning data — preserved verbatim from the server's terminal response.

### Fail-Fast Errors

`Save JSON` never writes a partial archive. When export fails, the button shows `⚠ Failed` and the runtime returns a typed error for diagnostics. The common cases:

- **missing auth** — retry after triggering one normal platform request so fresh provider auth headers / Gemini `at` context are captured; a 401/403 response clears the stale provider snapshot.
- **not terminal** — the response was not final; retry once the conversation is complete.
- **id mismatch / timeout / parse failure / HTTP failure / download failure** — see `docs/debug-logs-guide.md`.

### Bulk Export Chats

From the extension popup:

1. Set **Max chats** (`0 = all`; default `0`).
2. Click **Export Chats**.

The extension discovers conversation IDs from the platform list endpoint, fetches each detail payload (paced, with a per-request timeout and bounded `429` handling), and downloads one JSON file per conversation. The popup reports `Exported X/Y chats on <platform>` plus any warnings.

### Popup Tools

From the extension popup you can:

1. Set **Max chats** and run `Export Chats` from the active platform tab.
2. Export the bounded in-memory stream-debug records.
3. Clear the stream-debug records.

### Exporting Debug Logs

1. Click the extension icon to open the Popup UI.
2. Click **Export Stream Debug** to download the raw ordered stream frames.
3. Click **Clear Stream Debug** after the artifact is no longer needed.

For stream/framing issues, export the **stream-debug record(s)** through the explicit stream-debug export path. Interpretation guidance lives in `docs/debug-logs-guide.md`.

## 🤝 Contributing

### Setup for Contributors

1. Fork the repository.
2. Clone your fork: `git clone <your-fork-url>`.
3. Create a branch: `git checkout -b feature/your-feature`.
4. Make changes and commit.
5. Run code quality checks: `bun run check`.
6. Push and create a Pull Request.

### Commit Guidelines

We follow **Semantic Versioning**. The extension version is automatically bumped based on your commit messages.

Use **[Conventional Commits](https://www.conventionalcommits.org/)**:

- **`feat:`** → **Minor** version bump (e.g., `1.1.0` → `1.2.0`).
- **`fix:`** → **Patch** version bump (e.g., `1.1.0` → `1.1.1`).
- **`BREAKING CHANGE:`** → **Major** version bump (e.g., `1.1.0` → `2.0.0`).
- **`docs:`, `chore:`, `refactor:`, `test:`** → **No** version bump.

> **Note:** Pull Requests must be squashed or use these conventions in the merge commit message to trigger the release workflow properly.

## 🔗 Resources

- [WXT Documentation](https://wxt.dev)
- [Chrome Extension API](https://developer.chrome.com/docs/extensions/)
- [Biome Documentation](https://biomejs.dev)
- [Bun Documentation](https://bun.sh)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
