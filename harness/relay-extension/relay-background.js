(() => {
    const messageType = 'BLACKIYA_DEV_RELAY_EVENT';
    const defaultRelayUrl = 'http://127.0.0.1:4177/events';
    const eventKinds = new Set([
        'stream-start',
        'stream-frame',
        'stream-end',
        'stream-export',
        'save-click',
        'save-state',
    ]);
    const frameKinds = new Set(['data', 'raw', 'raw_chunk', 'sse_event', 'ndjson_line', 'done', 'refusal', 'replacement', 'erase']);
    const frameEvents = new Set(['done', 'refusal', 'replacement', 'erase', 'close', 'abort', 'error']);
    const saveStates = new Set(['idle', 'loading', 'success', 'error']);
    const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

    const isLocalRelayUrl = (value) => {
        try {
            const url = new URL(value);
            return (
                url.protocol === 'http:' &&
                (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
                url.pathname === '/events' &&
                !url.search &&
                !url.hash
            );
        } catch {
            return false;
        }
    };

    const sanitizePath = (value) => {
        if (typeof value !== 'string' || value.length === 0) {
            return undefined;
        }
        try {
            return (new URL(value, 'https://blackiya.invalid').pathname || '/').slice(0, 512);
        } catch {
            return value.split(/[?#]/, 1)[0].slice(0, 512) || undefined;
        }
    };

    const boundedInteger = (value, maximum) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : undefined;

    const assignPlatformAndRequestFields = (event, value) => {
        if (value.platform === 'ChatGPT' || value.platform === 'Gemini' || value.platform === 'Grok') {
            event.platform = value.platform;
        }
        const path = sanitizePath(value.path || value.url);
        if (path) {
            event.path = path;
        }
        if (typeof value.method === 'string' && methods.has(value.method.toUpperCase())) {
            event.method = value.method.toUpperCase();
        }
    };

    const assignFrameFields = (event, value) => {
        if (typeof value.streamId === 'string' && /^[a-zA-Z0-9:_-]{1,96}$/.test(value.streamId)) {
            event.streamId = value.streamId;
        }
        const sequence = boundedInteger(value.sequence, 1_000_000);
        if (sequence !== undefined) {
            event.sequence = sequence;
        }
        if (frameKinds.has(value.frameKind)) {
            event.frameKind = value.frameKind;
        }
        if (frameEvents.has(value.event)) {
            event.event = value.event;
        }
        const bytes = boundedInteger(value.bytes, 64 * 1024 * 1024);
        if (bytes !== undefined) {
            event.bytes = bytes;
        }
    };

    const assignStreamSummaryFields = (event, value) => {
        const frameCount = boundedInteger(value.frameCount, 1_000_000);
        if (frameCount !== undefined) {
            event.frameCount = frameCount;
        }
        const totalBytes = boundedInteger(value.totalBytes, 64 * 1024 * 1024);
        if (totalBytes !== undefined) {
            event.totalBytes = totalBytes;
        }
        const streamCount = boundedInteger(value.streamCount, 1_000);
        if (streamCount !== undefined) {
            event.streamCount = streamCount;
        }
        if (typeof value.truncated === 'boolean') {
            event.truncated = value.truncated;
        }
    };

    const assignSaveFields = (event, value) => {
        if (typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) {
            event.status = value.status;
        }
        if (saveStates.has(value.state)) {
            event.state = value.state;
        }
        if (typeof value.errorKind === 'string' && /^[a-z_]{1,64}$/.test(value.errorKind)) {
            event.errorKind = value.errorKind;
        }
        if (typeof value.disabled === 'boolean') {
            event.disabled = value.disabled;
        }
    };

    const sanitizeEvent = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !eventKinds.has(value.kind)) {
            return null;
        }
        const event = {
            schemaVersion: 1,
            source: 'blackiya-dev-relay',
            capturedAt: Date.now(),
            kind: value.kind,
        };
        assignPlatformAndRequestFields(event, value);
        assignFrameFields(event, value);
        assignStreamSummaryFields(event, value);
        assignSaveFields(event, value);
        return event;
    };

    const forward = async (value) => {
        const event = sanitizeEvent(value);
        if (!event) {
            return;
        }
        const config = await chrome.storage.local.get({ relayEnabled: false, relayUrl: defaultRelayUrl });
        if (config.relayEnabled !== true || !isLocalRelayUrl(String(config.relayUrl))) {
            return;
        }
        try {
            await fetch(String(config.relayUrl), {
                method: 'POST',
                headers: { 'content-type': 'application/x-ndjson' },
                body: `${JSON.stringify(event)}\n`,
            });
        } catch {
            // The debug relay is best-effort and must never affect the tab.
        }
    };

    chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === messageType) {
            void forward(message.event);
        }
    });
})();
