import { isMetaConversationId } from './request';

export const META_ARTIFACT_MESSAGE_TYPE = 'BLACKIYA_META_ARTIFACT';

const PUSH_PREFIX = 'self.__next_f.push(';
const USERCONTENT_ORIGIN_PATTERN = /^https:\/\/[a-z0-9-]+\.a\.metaaiusercontent\.com$/i;
const USERCONTENT_HOST_PATTERN = /^[a-z0-9-]+\.a\.metaaiusercontent\.com$/i;
const META_PARENT_ORIGINS = new Set(['https://www.meta.ai', 'https://meta.ai']);
const T_CHUNK_PATTERN = /(?:^|\n)\d+:T([0-9a-fA-F]+),/;

type ScriptText = { textContent: string | null };

export type MetaArtifactKind = 'markdown' | 'document';

export type MetaArtifactRequest = {
    kind: MetaArtifactKind;
    artifactUuid: string;
};

type ArtifactMessage = {
    type: typeof META_ARTIFACT_MESSAGE_TYPE;
    artifactUuid: string;
    content: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const decodeHtmlEntities = (value: string) =>
    value
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

const stripHtmlPreview = (value: string) => decodeHtmlEntities(value.replace(/<[^>]+>/g, ''));

const decodeArtifactPreview = (value: string) => (value.trimStart().startsWith('<') ? stripHtmlPreview(value) : value);

export const parseMetaArtifactRequest = (url: string): MetaArtifactRequest | null => {
    try {
        const parsed = new URL(url);
        if (
            parsed.protocol !== 'https:' ||
            !USERCONTENT_HOST_PATTERN.test(parsed.hostname) ||
            (parsed.pathname !== '/markdown' && parsed.pathname !== '/document')
        ) {
            return null;
        }
        const artifactUuid = parsed.searchParams.get('artifact_uuid');
        if (!artifactUuid || !isMetaConversationId(artifactUuid)) {
            return null;
        }
        return {
            kind: parsed.pathname === '/document' ? 'document' : 'markdown',
            artifactUuid,
        };
    } catch {
        return null;
    }
};

export const extractMetaArtifactContentFromScripts = (
    scripts: Iterable<ScriptText>,
    maxBytes: number,
): string | null => {
    for (const script of scripts) {
        const text = script.textContent?.trim();
        if (
            !text?.startsWith(PUSH_PREFIX) ||
            !text.endsWith(')') ||
            text.length > maxBytes ||
            new TextEncoder().encode(text).byteLength > maxBytes
        ) {
            continue;
        }
        try {
            const push = JSON.parse(text.slice(PUSH_PREFIX.length, -1)) as unknown;
            if (!Array.isArray(push) || typeof push[1] !== 'string') {
                continue;
            }
            const match = T_CHUNK_PATTERN.exec(push[1]);
            T_CHUNK_PATTERN.lastIndex = 0;
            if (!match) {
                continue;
            }
            const hexLength = match[1];
            if (!hexLength) {
                continue;
            }
            const declaredBytes = Number.parseInt(hexLength, 16);
            if (!Number.isFinite(declaredBytes) || declaredBytes <= 0 || declaredBytes > maxBytes) {
                continue;
            }
            const start = match.index + match[0].length;
            const encoded = new TextEncoder().encode(push[1].slice(start));
            const content = decodeArtifactPreview(new TextDecoder().decode(encoded.subarray(0, declaredBytes)));
            if (content.length > 0 && new TextEncoder().encode(content).byteLength <= maxBytes) {
                return content;
            }
        } catch {}
    }
    return null;
};

export const isMetaUsercontentOrigin = (origin: string): boolean => USERCONTENT_ORIGIN_PATTERN.test(origin);

export const resolveMetaArtifactParentOrigin = (input: {
    ancestorOrigin?: string;
    referrer?: string;
}): string | null => {
    for (const candidate of [input.ancestorOrigin, input.referrer]) {
        if (!candidate) {
            continue;
        }
        try {
            const origin = candidate.startsWith('https://') ? new URL(candidate).origin : candidate;
            if (META_PARENT_ORIGINS.has(origin)) {
                return origin;
            }
        } catch {}
    }
    return null;
};

export const ingestMetaArtifactMessageEvent = (
    event: { origin: string; source: unknown; data: unknown },
    parentWindow: unknown,
    ingest: (artifactUuid: string, content: string) => void,
): boolean => {
    if (event.source === parentWindow || event.source == null || !isMetaUsercontentOrigin(event.origin)) {
        return false;
    }
    if (!isRecord(event.data) || event.data.type !== META_ARTIFACT_MESSAGE_TYPE) {
        return false;
    }
    if (
        typeof event.data.artifactUuid !== 'string' ||
        !isMetaConversationId(event.data.artifactUuid) ||
        typeof event.data.content !== 'string' ||
        event.data.content.length === 0
    ) {
        return false;
    }
    ingest(event.data.artifactUuid, event.data.content);
    return true;
};

export const publishMetaArtifactToParent = (target: {
    location: { href: string; ancestorOrigins?: ArrayLike<string | undefined> };
    document: { referrer: string; querySelectorAll: (selector: string) => Iterable<ScriptText> };
    parent: { postMessage: (data: unknown, targetOrigin: string) => void };
}): boolean => {
    const request = parseMetaArtifactRequest(target.location.href);
    const parentOrigin = resolveMetaArtifactParentOrigin({
        ancestorOrigin: target.location.ancestorOrigins?.[0],
        referrer: target.document.referrer,
    });
    if (!request || !parentOrigin) {
        return false;
    }
    const content = extractMetaArtifactContentFromScripts(target.document.querySelectorAll('script'), 16 * 1024 * 1024);
    if (!content) {
        return false;
    }
    const message: ArtifactMessage = {
        type: META_ARTIFACT_MESSAGE_TYPE,
        artifactUuid: request.artifactUuid,
        content,
    };
    target.parent.postMessage(message, parentOrigin);
    return true;
};
