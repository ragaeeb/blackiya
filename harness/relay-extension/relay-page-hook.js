(() => {
    if (window.__BLACKIYA_DEV_RELAY_PAGE_HOOK__ === true) {
        return;
    }
    window.__BLACKIYA_DEV_RELAY_PAGE_HOOK__ = true;

    const messageType = 'BLACKIYA_DEV_RELAY_EVENT';
    const generationPath = '/backend-api/f/conversation';
    let streamCounter = 0;

    const post = (event) => {
        window.postMessage({ type: messageType, event: { ...event, capturedAt: Date.now() } }, window.location.origin);
    };

    const pathOf = (value) => {
        try {
            return new URL(String(value), window.location.href).pathname || '/';
        } catch {
            return String(value).split(/[?#]/, 1)[0] || '/';
        }
    };

    const isGenerationRequest = (path) => path === generationPath || path.startsWith(`${generationPath}/`);

    const methodOf = (input, init) => {
        if (typeof init?.method === 'string' && init.method.length > 0) {
            return init.method.toUpperCase();
        }
        if (input instanceof Request && input.method) {
            return input.method.toUpperCase();
        }
        return 'GET';
    };

    const classifyFrame = (text) => {
        const normalized = text.trim().replace(/^(?:data:\s*)+/i, '').trim();
        if (/^\[DONE\]$/i.test(normalized)) {
            return { frameKind: 'done', event: 'done' };
        }
        if (/"finish_reason"\s*:\s*"refusal"|"is_refusal"\s*:\s*true/i.test(normalized)) {
            return { frameKind: 'refusal', event: 'refusal' };
        }
        if (/"action"\s*:\s*"replace(?:ment)?"|"replacement"\s*:\s*true/i.test(normalized)) {
            return { frameKind: 'replacement', event: 'replacement' };
        }
        if (/"action"\s*:\s*"(?:erase_previous_tokens|erase|delete)"/i.test(normalized)) {
            return { frameKind: 'erase', event: 'erase' };
        }
        return { frameKind: text.includes('data:') ? 'sse_event' : 'data' };
    };

    const captureStream = async (response, streamId, path) => {
        try {
            const reader = response.clone().body?.getReader();
            if (!reader) {
                post({ kind: 'stream-end', platform: 'ChatGPT', path, method: 'POST', streamId, status: response.status });
                return;
            }
            const decoder = new TextDecoder();
            let pending = '';
            let sequence = 0;
            let frameCount = 0;
            let totalBytes = 0;
            const emitFrame = (frameText) => {
                const text = frameText.trim();
                if (!text) {
                    return;
                }
                const classification = classifyFrame(text);
                post({
                    kind: 'stream-frame',
                    platform: 'ChatGPT',
                    path,
                    method: 'POST',
                    streamId,
                    sequence,
                    bytes: new TextEncoder().encode(text).byteLength,
                    ...classification,
                });
                sequence += 1;
                frameCount += 1;
            };
            while (true) {
                const result = await reader.read();
                if (result.done) {
                    break;
                }
                totalBytes += result.value.byteLength;
                pending += decoder.decode(result.value, { stream: true });
                const parts = pending.split(/\r?\n\r?\n|\r?\n/);
                pending = parts.pop() ?? '';
                for (const part of parts) {
                    emitFrame(part);
                }
            }
            pending += decoder.decode();
            emitFrame(pending);
            post({
                kind: 'stream-end',
                platform: 'ChatGPT',
                path,
                method: 'POST',
                streamId,
                status: response.status,
                frameCount,
                totalBytes,
                event: 'close',
            });
        } catch {
            post({ kind: 'stream-end', platform: 'ChatGPT', path, method: 'POST', streamId, event: 'error' });
        }
    };

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const path = pathOf(args[0]);
        if (!isGenerationRequest(path)) {
            return originalFetch.apply(this, args);
        }
        const method = methodOf(args[0], args[1]);
        const streamId = `relay:${++streamCounter}`;
        post({ kind: 'stream-start', platform: 'ChatGPT', path, method, streamId });
        try {
            const response = await originalFetch.apply(this, args);
            void captureStream(response, streamId, path);
            return response;
        } catch (error) {
            post({ kind: 'stream-end', platform: 'ChatGPT', path, method, streamId, event: 'error' });
            throw error;
        }
    };

    const saveStateOf = (button) => {
        const text = button.textContent?.trim() ?? '';
        if (text.includes('Saving')) {
            return 'loading';
        }
        if (text.includes('Saved')) {
            return 'success';
        }
        if (text.includes('Failed')) {
            return 'error';
        }
        return 'idle';
    };

    let lastSaveState = '';
    const scanSaveButton = () => {
        const button = document.querySelector('#blackiya-v3-export-chat-btn');
        if (!(button instanceof HTMLButtonElement)) {
            return;
        }
        const state = saveStateOf(button);
        if (state !== lastSaveState) {
            lastSaveState = state;
            post({ kind: 'save-state', platform: 'ChatGPT', state, disabled: button.disabled });
        }
        if (button.dataset.blackiyaDevRelayObserved !== '1') {
            button.dataset.blackiyaDevRelayObserved = '1';
            button.addEventListener('click', () => post({ kind: 'save-click', platform: 'ChatGPT' }), true);
        }
    };

    const installSaveObserver = () => {
        scanSaveButton();
        const observer = new MutationObserver(scanSaveButton);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['disabled'],
        });
    };

    if (document.documentElement) {
        installSaveObserver();
    } else {
        document.addEventListener('DOMContentLoaded', installSaveObserver, { once: true });
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== window.location.origin) {
            return;
        }
        const data = event.data;
        if (
            !data ||
            typeof data !== 'object' ||
            data.type !== 'BLACKIYA_V3_STREAM_DEBUG_EXPORT_RESPONSE' ||
            !Array.isArray(data.records)
        ) {
            return;
        }
        for (const record of data.records.slice(0, 64)) {
            if (!record || typeof record !== 'object') {
                continue;
            }
            post({
                kind: 'stream-export',
                platform: record.platform,
                path: pathOf(record.path),
                method: record.method,
                streamId: record.streamId,
                frameCount: Array.isArray(record.frames) ? record.frames.length : 0,
                totalBytes: record.totalByteLength,
                streamCount: data.records.length,
                truncated: record.truncated === true,
            });
        }
    });
})();
