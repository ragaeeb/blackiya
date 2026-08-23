# Privacy Policy for Blackiya

**Effective Date: August 23, 2026**

Blackiya ("we", "us", or "our") is committed to protecting your privacy. This Privacy Policy explains how we handle information in connection with the Blackiya browser extension.

## 1. Single Purpose

Blackiya is designed with a single, clear purpose: to allow users to capture and save their conversation data from supported AI platforms as terminal JSON files for personal use and archiving. Single-chat `Save JSON` supports ChatGPT, Gemini, Grok on `grok.com` and `x.com`, Claude, Amazon Nova, Meta Muse, Qwen, Z.ai, and DeepSeek. Bulk `Export Chats` supports ChatGPT, Gemini, and `grok.com`. Export is always explicit—nothing is written to a file without your click.

## 2. No Data Collection

**We do not collect any personal data.**

- We do not store your conversations on any servers.
- We do not track your browsing history.
- We do not collect personally identifiable information (PII), health data, financial data, or location data.
- We do not use any analytics or telemetry services.

## 3. Local, Explicit Processing

All data extraction, processing, and formatting occur locally within your browser's environment. The extension may reuse an eligible terminal canonical detail response that the page already loaded; if none is available, it makes a deterministic direct detail request only where the platform adapter supports one. When you click `Save JSON` or `Export Chats`, the validated result is saved as a JSON file on your device. This data never leaves your machine unless you manually choose to share the resulting JSON file.

## 4. Request-Context Capture Without Credential Persistence

To make an eligible direct export request, the extension may use, in page-local memory:

- a narrow provider-specific allowlist of authentication or client-context headers, and
- for Gemini, the batchexecute request context (`at` token and related RPC fields).

This request-context is held in MAIN-world page-local stores with a five-minute expiry and consumed there by the explicit export handler. It is **not** returned to the isolated UI, placed in `window.postMessage` messages, placed in the conversation-response cache, written into exported JSON, or persisted across sessions or to disk. If required context is missing, the extension fails fast rather than guessing or storing credentials.

The MAIN-world command bridge requires the exact same window and origin and rejects absent, `null`, synthetic, or cross-origin event values. Because it uses page-visible `window.postMessage`, same-page scripts can still observe and replay token-stamped safe commands; a MAIN-world bridge cannot provide extension-private command integrity. Hostile-page replay is outside v3's threat model. Credentials and conversation or stream payloads are never carried in those messages.

## 5. Bounded, In-Memory Conversation Cache

To avoid making a redundant request when a conversation is already loaded, the extension clones narrowly classified page-owned canonical detail responses. It parses and terminal-validates the clone without consuming or changing the response delivered to the website.

The shared terminal cache is:

- **short-lived** — entries expire after five minutes;
- **bounded** — up to 12 entries, 16 MiB per entry, and 48 MiB total;
- **in-memory only** — it is never written to extension storage or disk and disappears with page/session teardown;
- **credential-free** — request headers, cookies, tokens, and Gemini RPC context are not stored with conversation entries; and
- **explicit at download time** — observing a response does not create a file. A JSON file is written only after `Save JSON` is clicked.

Some platforms need additional fail-closed assembly before an entry is eligible. Meta Muse classifies its multiplexed GraphQL requests by request body and joins backward pages only in cursor order. Amazon Nova accepts only the conversation RPC identified by its target header. Z.ai combines identity-consistent conversation detail and message-batch responses. Incomplete, mismatched, oversized, expired, or non-terminal data is not exported.

## 6. Bounded, In-Memory Stream-Debug Capture

For troubleshooting, the extension may record an ordered, in-memory trace of raw stream frames (SSE, NDJSON/line, or raw) for recognized generation endpoints. This capture is:

- **bounded** by maximum stream count, frames per stream, and bytes per stream, with a short retention (TTL);
- **in-memory only** — it is never written to conversation exports and is evicted automatically;
- **sanitized** — request URLs are reduced to their path (query strings and hashes are stripped), and stream text is retained only inside the bounded frame capture;
- **explicit** — the trace is exported or cleared only when you request it. The MAIN-world handler performs the download and returns only a count/filename status to the isolated UI; frame text does not cross the world boundary.

## 7. No Remote Code

Blackiya does not use or execute any remote code. All JavaScript and technical assets required for the extension to function are bundled within the extension package itself, in compliance with Chrome Web Store security policies.

## 8. Permissions

The extension requests the following permissions for the reasons stated:

- **`storage`**: Used solely to store local extension preferences. Conversation data, credentials, and stream-debug records are not persisted there.
- **`host_permissions`**: Required to run on and communicate with the internal APIs of ChatGPT, Gemini, Grok (`grok.com` and the `/i/grok` surface on `x.com`), Claude, Amazon Nova, Meta Muse, Qwen, Z.ai, and DeepSeek for explicit conversation export. Content-script injection on `x.com` is limited to `/i/grok*`.

## 9. Website Content

The extension reads relevant request/response content from supported conversation pages only to facilitate export and bounded debugging. Conversation responses may remain in the bounded in-memory terminal cache for up to five minutes. Stream-debug records use their own bounded in-memory retention. Neither cache is persistent; the only durable conversation or debug data is a file you explicitly choose to download.

## 10. Changes to This Policy

We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Effective Date" at the top.

## 11. Contact Us

If you have any questions or suggestions about our Privacy Policy, do not hesitate to contact us through our [GitHub repository](https://github.com/ragaeeb/blackiya).
