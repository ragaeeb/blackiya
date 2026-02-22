import {
    detectPlatformFromHostname,
    isDiscoveryDiagnosticsEnabled,
    safePathname,
} from '@/entrypoints/interceptor/discovery';
import { isLikelyChatGptApiPath } from '@/platforms/chatgpt/registry';
import { isLikelyGeminiApiPath } from '@/platforms/gemini/registry';
import { isLikelyGrokApiPath } from '@/platforms/grok/registry';
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

const STATIC_ASSET_PATH_REGEX = /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico)$/i;
const isStaticAssetPath = (path: string) => STATIC_ASSET_PATH_REGEX.test(path);

const parseDiscoveryUrl = (url: string) => {
    try {
        const parsed = new URL(url);
        return { pathname: parsed.pathname, search: parsed.search };
    } catch {
        return { pathname: safePathname(url), search: '' };
    }
};

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
    const { pathname, search } = parseDiscoveryUrl(url);
    if (isStaticAssetPath(pathname)) {
        return;
    }
    log('info', '[DISCOVERY] POST', {
        path: pathname,
        search: search.slice(0, 150),
        status: response.status,
        contentType: response.headers.get('content-type'),
    });
    response
        .clone()
        .text()
        .then((text) => {
            if (text.length > 500) {
                log('info', '[DISCOVERY] Response', {
                    path: pathname,
                    size: text.length,
                    preview: text.slice(0, 300),
                });
            }
            emitDiscoveryDumpFrame('DISCOVERY', pathname, text, streamDump);
        })
        .catch(() => {});
};

export const logDiscoveryXhr = (url: string, responseText: string, log: LogFn, streamDump: EmitStreamDumpFn) => {
    if (!isDiscoveryDiagnosticsEnabled()) {
        return;
    }
    const { pathname, search } = parseDiscoveryUrl(url);
    if (isStaticAssetPath(pathname) || responseText.length <= 500) {
        return;
    }
    log('info', '[DISCOVERY] XHR', {
        path: pathname,
        search: search.slice(0, 150),
        size: responseText.length,
        preview: responseText.slice(0, 300),
    });
    emitDiscoveryDumpFrame('XHR DISCOVERY', pathname, responseText, streamDump);
};

const resolveEndpointMissPlatform = (hostname: string, url: string): 'ChatGPT' | 'Gemini' | 'Grok' | null => {
    if ((hostname.includes('chatgpt.com') || hostname.includes('chat.openai.com')) && isLikelyChatGptApiPath(url)) {
        return 'ChatGPT';
    }
    if (hostname.includes('gemini.google.com') && isLikelyGeminiApiPath(url)) {
        return 'Gemini';
    }
    if ((hostname.includes('grok.com') || hostname.includes('x.com')) && isLikelyGrokApiPath(url)) {
        return 'Grok';
    }
    return null;
};

export const logAdapterEndpointMiss = (
    channel: 'fetch' | 'xhr',
    url: string,
    xhrMeta: { method?: string; status?: number } | undefined,
    log: LogFn,
    shouldLogTransient: ShouldLogTransientFn,
) => {
    const path = safePathname(url);
    const platform = resolveEndpointMissPlatform(window.location.hostname, url);
    if (!platform) {
        return;
    }
    if (!shouldLogTransient(`adapter-miss:${platform.toLowerCase()}:${channel}:${path}`, 8000)) {
        return;
    }
    log('info', `${platform} endpoint unmatched by adapter`, {
        path,
        ...(xhrMeta ?? {}),
    });
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
    logAdapterEndpointMiss(channel, url, xhrMeta, log, shouldLogTransient);
};
