# Privacy Policy for Blackiya

**Effective Date: August 21, 2026**

Blackiya ("we", "us", or "our") is committed to protecting your privacy. This Privacy Policy explains how we handle information in connection with the Blackiya browser extension.

## 1. Single Purpose

Blackiya is designed with a single, clear purpose: to allow users to capture and save their conversation data from supported AI platforms (ChatGPT, Gemini, and Grok) as terminal JSON files for personal use and archiving. Export is always explicit — nothing is written to a file without you clicking `Save JSON` or `Export Chats`.

## 2. No Data Collection

**We do not collect any personal data.**

- We do not store your conversations on any servers.
- We do not track your browsing history.
- We do not collect personally identifiable information (PII), health data, financial data, or location data.
- We do not use any analytics or telemetry services.

## 3. Local, Explicit Processing

All data extraction, processing, and formatting occur locally within your browser's environment. When you click `Save JSON` or `Export Chats`, the extension requests the conversation data from the platform's API for the active tab and saves the result as a JSON file on your device. This data never leaves your machine unless you manually choose to share the resulting JSON file.

## 4. Request-Context Capture Without Credential Persistence

To make a successful export, the extension must authenticate to the platform on your behalf. It therefore reads, in memory and only at the moment of export:

- platform authentication headers, and
- for Gemini, the batchexecute request context (`at` token and related RPC fields).

This request-context is held in the MAIN-world page-local stores with a short expiry and consumed there by the explicit export handler. It is **not** returned to the isolated UI, placed in `window.postMessage` messages, written into exported JSON, or persisted across sessions or to disk. If the request-context is missing, the extension fails fast rather than guessing or storing credentials.

## 5. Bounded, In-Memory Stream-Debug Capture

For troubleshooting, the extension may record an ordered, in-memory trace of raw stream frames (SSE, NDJSON/line, or raw) for recognized generation endpoints. This capture is:

- **bounded** by maximum stream count, frames per stream, and bytes per stream, with a short retention (TTL);
- **in-memory only** — it is never written to conversation exports and is evicted automatically;
- **sanitized** — request URLs are reduced to their path (query strings and hashes are stripped), and stream text is retained only inside the bounded frame capture;
- **explicit** — the trace is exported or cleared only when you request it. The MAIN-world handler performs the download and returns only a count/filename status to the isolated UI; frame text does not cross the world boundary.

## 6. No Remote Code

Blackiya does not use or execute any remote code. All JavaScript and technical assets required for the extension to function are bundled within the extension package itself, in compliance with Chrome Web Store security policies.

## 7. Permissions

The extension requests the following permissions for the reasons stated:

- **`storage`**: Used solely to store local extension preferences. Conversation data, credentials, and stream-debug records are not persisted there.
- **`host_permissions`**: Required to communicate with the internal APIs of ChatGPT, Gemini, and Grok to retrieve the conversation data for exporting.

## 8. Website Content

The extension reads content from the supported websites (`chatgpt.com`, `gemini.google.com`, `grok.com`) only for the purpose of facilitating the export feature. This data is processed in real-time and is not stored by the extension after the export is complete, except for bounded in-memory stream-debug records and files you choose to download.

## 9. Changes to This Policy

We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Effective Date" at the top.

## 10. Contact Us

If you have any questions or suggestions about our Privacy Policy, do not hesitate to contact us through our [GitHub repository](https://github.com/ragaeeb/blackiya).
