import {
    detectPlatformFromHostname,
    isDiscoveryDiagnosticsEnabled,
    safePathname,
} from '@/entrypoints/interceptor/discovery';
import type { StreamDumpFrameMessage } from '@/utils/protocol/messages';

type LogFn = (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
type ShouldLogTransientFn = (key: string, intervalMs?: number) => boolean;
type EmitStreamDumpFn = (
    attemptId: string,
    conversationId: string | undefined,
    kind: StreamDumpFrameMessage['kind'],
    text: string,
    chunkBytes?: number,
    platformOverride?: string,
) => void;

const isStaticAssetPath = (path: string) => !!path.match(/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico)$/i);

export const isDiscoveryModeHost = (hostname: string) =>
    hostname.includes('gemini.google.com') || hostname.includes('x.com') || hostname.includes('grok.com');

const emitDiscoveryDumpFrame = (label: string, path: string, text: string, streamDump: EmitStreamDumpFn) => {
    if (text.length <= 1000) {
        return;
    }
    const platform = detectPlatformFromHostname();
    const attemptId = `discovery:${platform.toLowerCase()}:${Date.now()}`;
    const preview = text.length > 8000 ? text.slice(0, 8000) : text;
    streamDump(
        attemptId,
        undefined,
        'snapshot',
        `[${platform} ${label}] ${path} (${text.length}b)\n${preview}`,
        text.length,
        platform,
    );
};

export const logConversationSkip = (
    channel: 'API' | 'XHR',
    url: string,
    log: LogFn,
    shouldLogTransient: ShouldLogTransientFn,
) => {
    const path = safePathname(url);
    if (shouldLogTransient(`${channel}:skip:${path}`, 2500)) {
        log('info', `${channel} skip conversation URL`, { host: window.location.hostname, path });
    }
};

export const logDiscoveryFetch = (url: string, response: Response, log: LogFn, streamDump: EmitStreamDumpFn) => {
    if (!isDiscoveryDiagnosticsEnabled()) {
        return;
    }
    const urlObj = new URL(url);
    if (isStaticAssetPath(urlObj.pathname)) {
        return;
    }
    log('info', '[DISCOVERY] POST', {
        path: urlObj.pathname,
        search: urlObj.search.slice(0, 150),
        status: response.status,
        contentType: response.headers.get('content-type'),
    });
    response
        .clone()
        .text()
        .then((text) => {
            if (text.length > 500) {
                log('info', '[DISCOVERY] Response', {
                    path: urlObj.pathname,
                    size: text.length,
                    preview: text.slice(0, 300),
                });
            }
            emitDiscoveryDumpFrame('DISCOVERY', urlObj.pathname, text, streamDump);
        })
        .catch(() => {});
};

export const logDiscoveryXhr = (url: string, responseText: string, log: LogFn, streamDump: EmitStreamDumpFn) => {
    if (!isDiscoveryDiagnosticsEnabled()) {
        return;
    }
    const urlObj = new URL(url);
    if (isStaticAssetPath(urlObj.pathname) || responseText.length <= 500) {
        return;
    }
    log('info', '[DISCOVERY] XHR', {
        path: urlObj.pathname,
        search: urlObj.search.slice(0, 150),
        size: responseText.length,
        preview: responseText.slice(0, 300),
    });
    emitDiscoveryDumpFrame('XHR DISCOVERY', urlObj.pathname, responseText, streamDump);
};

export const logGeminiAdapterMiss = (
    channel: 'fetch' | 'xhr',
    url: string,
    xhrMeta: { method?: string; status?: number } | undefined,
    log: LogFn,
    shouldLogTransient: ShouldLogTransientFn,
) => {
    if (!window.location.hostname.includes('gemini.google.com')) {
        return;
    }
    if (!safePathname(url).includes('/_/BardChatUi/data/')) {
        return;
    }
    if (!shouldLogTransient(`gemini:adapter-miss:${channel}:${safePathname(url)}`, 8000)) {
        return;
    }
    log('warn', 'Gemini endpoint unmatched by adapter', {
        path: safePathname(url),
        ...(xhrMeta ?? {}),
    });
};
