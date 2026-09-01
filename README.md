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

A high-performance Chrome extension for exporting terminal conversation JSON from ChatGPT, Gemini, Grok, Claude, Amazon Nova, Meta Muse, Qwen, Z.ai, and DeepSeek—locally and on demand.

## 📚 Architecture Docs

- Architecture source of truth: `docs/architecture.md`
- Debug logs guide: `docs/debug-logs-guide.md`

## 🎯 Features

- ✅ **Single-Chat Ready-Terminal Export**: The Blackiya icon (accessible as `Save JSON`) supports ChatGPT, Gemini, Grok on `grok.com` and `x.com`, Claude, Amazon Nova, Meta Muse, Qwen, Z.ai, and DeepSeek. It validates identity and terminal readiness before downloading the complete archive, including structured messages, reasoning, tools, artifacts, and the provider payload retained by the adapter.
- ✅ **Cache-First Save**: The extension reuses an eligible terminal canonical detail response that the page already loaded. The cache is in-memory only, expires after five minutes, and is bounded to 12 entries, 16 MiB per entry, and 48 MiB total. On a miss, the icon uses a deterministic direct detail request only where the adapter supports one.
- ✅ **Fail-Fast Single Save**: Every non-happy single-chat path returns a typed error—no retries, degraded/partial export, speculative warm fetch, or silent data loss. Cache-only providers fail when no fresh ready response is available. Bulk export separately retains bounded `429` retries.
- ✅ **Bulk `Export Chats`**: From the popup, export ChatGPT, Gemini, or `grok.com` conversation lists (`Max chats`, where `0 = all`). Each detail payload must match its requested id and be ready-terminal before download; requests use pacing, per-request timeout, and bounded `429` retry handling.
- ✅ **Stream-Debug Capture**: Raw ordered stream frames (SSE/NDJSON/raw) are recorded in memory, bounded, sanitized, and exported or cleared explicitly — never written into conversation JSON.
- ✅ **Request-Context Without Credential Persistence**: Allowlisted provider headers and Gemini batchexecute context remain in expiring page-local memory and are never written into exports, cached conversation records, or persistent storage.
- ✅ **Smart Titles**: Automatic conversation title resolution and export-time filename generation.
- ✅ **Popup Controls**: Bulk export, stream-debug export, and stream-debug clearing in one place.
- ✅ **Complete Conversation Data**: Preserves ChatGPT's native `mapping` tree verbatim when supplied; its closed flat-message response keeps the source `messages` array while building an ordered mapping. Other adapters build a normalized message graph while retaining the complete canonical provider response in `raw_payload`.
- ✅ **Extensive Testing**: Regression-focused unit/integration coverage for adapters, single-export, bulk-export, and stream-debug.
- ✅ **Automated Releases**: CI/CD pipeline with Semantic Versioning and automated GitHub Releases.

## 🔒 Privacy & Compliance

- **Local-first and explicit.** Export happens only when you click the Blackiya icon or `Export Chats`; nothing is uploaded.
- **No credential persistence.** Request-context is captured in page-local memory with a short expiry and never written into exports or cached conversation records.
- **Bounded conversation cache.** Terminal page-owned detail responses live only in memory for up to five minutes and are automatically evicted by age, entry count, and byte limits.
- **Bounded export reads.** Single and bulk response bodies are capped at 16 MiB and cancelled on overflow; single-chat filenames always end in `.json`.
- **Precise invalidation boundaries.** An observed `401/403` clears the affected provider state, and first establishing or changing supported identity-bearing request context clears it where such a marker is available. The current sanitized evidence does not provide a reliable non-secret ordinary account-switch/logout marker for Claude, Meta Muse, Amazon Nova, DeepSeek, or Z.ai, so their caches are not represented as account-bound.
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
bun run har:analyze --input <file.har> --host chatgpt.com # Analyze a sanitized HAR
bun run compile          # Type-check
```

## 🏗️ Project Structure

```text
blackiya/
├── dist/                    # Build output (git-ignored)
│   └── chrome-mv3/            # Chrome extension build
├── entrypoints/
│   ├── main.content.ts        # v3 isolated UI/runtime entry (command-only bridge)
│   ├── interceptor.content.ts # Thin MAIN-world entrypoint (request-context + stream capture)
│   ├── interceptor/
│   │   └── bootstrap.ts       # MAIN-world interceptor implementation
│   └── popup/
│       ├── index.html         # Extension popup UI
│       └── App.tsx            # Popup logic (Export Chats, stream-debug tools)
├── features/
│   ├── runtime/               # v3 runtime plus MAIN-world command contracts/handlers
│   ├── single-export/         # On-demand terminal single-chat export (fail-fast)
│   ├── bulk-export/           # Bulk Export Chats orchestrator + platform providers
│   ├── export-controls/       # Blackiya icon control (UI)
│   └── stream-debug/          # Ordered stream capture + explicit export/clear
├── platforms/
│   ├── chatgpt/               # ChatGPT adapter + parsing/readiness modules
│   ├── gemini/                # Gemini adapter + RPC/title/conversation modules
│   ├── grok/                  # Grok adapter + NDJSON/title modules
│   ├── claude/                # Claude detail parser + readiness
│   ├── deepseek/              # DeepSeek history parser + readiness
│   ├── meta/                  # Meta GraphQL parser + cursor assembler
│   ├── nova/                  # Amazon Nova RPC parser + readiness
│   ├── qwen/                  # Qwen history parser + readiness
│   ├── zai/                   # Z.ai detail/batch parser + readiness
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
- `https://x.com/*` — enables injection before X's SPA navigates into Grok
- `https://claude.ai/*` — Claude
- `https://nova.amazon.com/*` — Amazon Nova
- `https://meta.ai/*` and `https://www.meta.ai/*` — Meta Muse
- `https://chat.qwen.ai/*` — Qwen
- `https://chat.z.ai/*` — Z.ai
- `https://chat.deepseek.com/*` — DeepSeek

The `x.com` content script is available across the origin so navigation from X home into Grok does not miss extension injection. The export controls are still route-gated: they mount only on `/i/grok?conversation={id}` and are removed again on unrelated X routes. `https://grok.x.com/*` is not a content-script match because those requests originate from the supported page context.

## 📝 Usage

### Single-Chat Export

1. Open a conversation on ChatGPT, Gemini, `grok.com`, `x.com/i/grok`, Claude, Amazon Nova, Meta Muse, Qwen, Z.ai, or DeepSeek and wait for the page to finish loading it.
2. Click the **Blackiya icon** (hover or focus it to see its accessible Save JSON label; the success state confirms the download).
3. The export first checks the bounded in-memory cache for the active conversation. If the page-loaded response is fresh, conversation-id-matched, and terminal, it downloads immediately. Otherwise it uses a deterministic direct detail request where supported. A candidate fallback is used only for an eligible `404`; there are no retries, speculative warm requests, or time-based recovery paths.

Claude, Amazon Nova, Meta Muse, and Z.ai rely on page-owned conversation data. If their canonical detail response was not observed, is incomplete, is too large, or has expired, the icon export fails fast instead of guessing a request. Reload or reopen the finished conversation so the platform loads it normally, then try again. Meta Muse joins its embedded initial detail with backward GraphQL pages in cursor order; Nova decrypts only the targeted conversation RPC and discards its response-local key; Z.ai combines the conversation detail and message batch before considering the archive eligible.

Claude accepts its current complete deep-research detail shape, including nil-root message graphs and terminal `stop_sequence` responses, while preserving thinking and tool blocks in the archive.

Downloads use `{conversation-title}_{timestamp}.json`.

The exported JSON contains complete conversation metadata and a normalized message graph. ChatGPT's native `mapping` is preserved verbatim when supplied; a closed flat-message detail response retains its source `messages` array and adds an ordered mapping. Other adapters retain their complete canonical provider response in `raw_payload` so structured reasoning, tools, artifacts, and provider-specific fields are not discarded.

### Fail-Fast Errors

The icon export never writes a partial archive. When export fails, its accessible label changes to `Save failed. Click to retry.` and the runtime returns a typed error for diagnostics. The common cases:

- **missing auth** — retry after triggering one normal platform request so fresh provider headers / Gemini `at` context are captured; a 401/403 response clears the stale provider snapshot.
- **missing endpoint** — no eligible cached response exists and the adapter has no deterministic direct request; reload or reopen a completed cache-only conversation and retry.
- **not terminal** — the response was not final; retry once the conversation is complete.
- **id mismatch / timeout / parse failure / HTTP failure / download failure** — see `docs/debug-logs-guide.md`.

### Bulk Export Chats

From the extension popup:

1. Set **Max chats** (`0 = all`; default `0`).
2. Click **Export Chats**.

Bulk export supports ChatGPT, Gemini, and `grok.com` only. The extension discovers conversation IDs from the platform list endpoint, fetches each detail payload (paced, with a per-request timeout and bounded `429` handling), and downloads one JSON file per conversation. The popup reports `Exported X/Y chats on <platform>` plus any warnings.

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
