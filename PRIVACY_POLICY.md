# Privacy Policy for Blackiya

**Effective Date: January 26, 2026**

Blackiya ("we", "us", or "our") is committed to protecting your privacy. This Privacy Policy explains how we handle information in connection with the Blackiya browser extension.

## 1. Single Purpose
Blackiya is designed with a single, clear purpose: to allow users to capture and save their conversation data from supported AI platforms (ChatGPT, Gemini, and Grok) as JSON files for personal use and archiving.

## 2. No Data Collection
**We do not collect any personal data.** 
- We do not store your conversations on any servers.
- We do not track your browsing history.
- We do not collect personally identifiable information (PII), health data, financial data, or location data.
- We do not use any analytics or telemetry services.

## 3. Local Processing
All data extraction, processing, and formatting occur locally within your browser's environment. When you click Save, the extension accesses the conversation data currently visible in your active tab to create the export. This data never leaves your machine unless you manually choose to share the resulting JSON file. If you call `window.__blackiya.getJSON()` / `window.__blackiya.getCommonJSON()` or subscribe via `window.__blackiya.subscribe(...)` from a supported LLM page, responses and status events are delivered only in that tab's local page context and are not transmitted elsewhere by the extension.

## 4. No Remote Code
Blackiya does not use or execute any remote code. All JavaScript and technical assets required for the extension to function are bundled within the extension package itself, in compliance with Chrome Web Store security policies.

## 5. Permissions
The extension requests the following permissions for the reasons stated:
- **`storage`**: Used solely to store your local extension preferences (e.g., log levels) and temporary local debug logs.
- **`host_permissions`**: Required to communicate with the internal APIs of ChatGPT, Gemini, and Grok to retrieve the conversation data for exporting.

## 6. Website Content
The extension reads content from the supported websites (`chatgpt.com`, `gemini.google.com`, `x.com`) only for the purpose of facilitating the export feature. This data is processed in real-time and is not stored by the extension after the export is complete, except for what you choose to download or copy.

## 7. Changes to This Policy
We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Effective Date" at the top.

## 8. Contact Us
If you have any questions or suggestions about our Privacy Policy, do not hesitate to contact us through our [GitHub repository](https://github.com/ragaeeb/blackiya).
