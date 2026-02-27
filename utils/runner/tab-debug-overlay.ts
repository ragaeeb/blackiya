import type { ExternalConversationEvent } from '@/utils/external-api/contracts';
import type { ConversationData } from '@/utils/types';

export const TAB_DEBUG_OVERLAY_SESSION_KEY = 'blackiya.tabDebugOverlay.visible';
export const TAB_DEBUG_OVERLAY_TOGGLE_MESSAGE = 'BLACKIYA_TAB_DEBUG_OVERLAY_TOGGLE';
export const TAB_DEBUG_OVERLAY_GET_STATE_MESSAGE = 'BLACKIYA_TAB_DEBUG_OVERLAY_GET_STATE';
export const TAB_DEBUG_OVERLAY_SET_STATE_MESSAGE = 'BLACKIYA_TAB_DEBUG_OVERLAY_SET_STATE';
export const TAB_DEBUG_OVERLAY_GET_SNAPSHOT_MESSAGE = 'BLACKIYA_TAB_DEBUG_OVERLAY_GET_SNAPSHOT';

const PANEL_ID = 'blackiya-tab-debug-overlay';
const MAX_ENTRIES = 12;
const MAX_PAYLOAD_CHARS = 36_000;
let fallbackVisibility = false;

type TabDebugCaptureEntry = {
    kind: 'capture';
    atMs: number;
    conversationId: string;
    attemptId: string | null;
    source: string;
    payloadPreview: string;
    payloadBytes: number;
};

type TabDebugExternalEntry = {
    kind: 'external';
    atMs: number;
    conversationId: string;
    eventType: ExternalConversationEvent['type'];
    eventId: string;
    contentHash: string | null;
    status: 'sent' | 'failed';
    payloadPreview: string;
    payloadBytes: number;
    error: string | null;
    listenerCount: number | null;
    delivered: number | null;
    dropped: number | null;
};

export type TabDebugOverlayState = {
    entries: Array<TabDebugCaptureEntry | TabDebugExternalEntry>;
    visible: boolean;
};

export type TabDebugOverlaySnapshot = {
    api: 'blackiya.tab-debug-overlay.v1';
    generatedAtMs: number;
    visible: boolean;
    recordCount: number;
    maxEntries: number;
    entries: Array<TabDebugCaptureEntry | TabDebugExternalEntry>;
    content: string;
};

export type TabDebugRuntimeMessage =
    | { type: typeof TAB_DEBUG_OVERLAY_TOGGLE_MESSAGE }
    | { type: typeof TAB_DEBUG_OVERLAY_GET_STATE_MESSAGE }
    | { type: typeof TAB_DEBUG_OVERLAY_SET_STATE_MESSAGE; enabled: boolean }
    | { type: typeof TAB_DEBUG_OVERLAY_GET_SNAPSHOT_MESSAGE };

export type TabDebugOverlayDeliveryStats = {
    listenerCount: number;
    delivered: number;
    dropped: number;
};

const sanitizeError = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message || error.name || 'Error';
    }
    return String(error ?? 'Unknown error');
};

const safePreview = (payload: unknown): { text: string; bytes: number } => {
    let serialized = '';
    try {
        serialized = JSON.stringify(payload, null, 2);
    } catch {
        serialized = '(Failed to serialize payload)';
    }
    const bytes = serialized.length;
    if (serialized.length <= MAX_PAYLOAD_CHARS) {
        return { text: serialized, bytes };
    }
    return {
        text: `${serialized.slice(0, MAX_PAYLOAD_CHARS)}\n... [truncated ${serialized.length - MAX_PAYLOAD_CHARS} chars]`,
        bytes,
    };
};

const pushEntry = (state: TabDebugOverlayState, entry: TabDebugOverlayState['entries'][number]) => {
    state.entries.unshift(entry);
    if (state.entries.length > MAX_ENTRIES) {
        state.entries.length = MAX_ENTRIES;
    }
};

export const createTabDebugOverlayState = (): TabDebugOverlayState => ({
    entries: [],
    visible: false,
});

export const readTabDebugOverlayVisibilityFromSession = (): boolean => {
    try {
        return window.sessionStorage.getItem(TAB_DEBUG_OVERLAY_SESSION_KEY) === '1';
    } catch {
        return fallbackVisibility;
    }
};

export const persistTabDebugOverlayVisibilityToSession = (visible: boolean) => {
    fallbackVisibility = visible;
    try {
        if (visible) {
            window.sessionStorage.setItem(TAB_DEBUG_OVERLAY_SESSION_KEY, '1');
            return;
        }
        window.sessionStorage.removeItem(TAB_DEBUG_OVERLAY_SESSION_KEY);
    } catch {
        // noop
    }
};

export const addTabDebugCaptureEntry = (
    state: TabDebugOverlayState,
    input: {
        conversationId: string;
        attemptId?: string | null;
        source: string;
        payload: ConversationData;
    },
) => {
    const preview = safePreview(input.payload);
    pushEntry(state, {
        kind: 'capture',
        atMs: Date.now(),
        conversationId: input.conversationId,
        attemptId: input.attemptId ?? null,
        source: input.source,
        payloadPreview: preview.text,
        payloadBytes: preview.bytes,
    });
};

export const addTabDebugExternalEventEntry = (
    state: TabDebugOverlayState,
    input: {
        event: ExternalConversationEvent;
        status: 'sent' | 'failed';
        error?: unknown;
        delivery?: TabDebugOverlayDeliveryStats | null;
    },
) => {
    const preview = safePreview(input.event);
    pushEntry(state, {
        kind: 'external',
        atMs: Date.now(),
        conversationId: input.event.conversation_id,
        eventType: input.event.type,
        eventId: input.event.event_id,
        contentHash: input.event.content_hash,
        status: input.status,
        payloadPreview: preview.text,
        payloadBytes: preview.bytes,
        error: input.status === 'failed' ? sanitizeError(input.error) : null,
        listenerCount: typeof input.delivery?.listenerCount === 'number' ? input.delivery.listenerCount : null,
        delivered: typeof input.delivery?.delivered === 'number' ? input.delivery.delivered : null,
        dropped: typeof input.delivery?.dropped === 'number' ? input.delivery.dropped : null,
    });
};

const formatTime = (atMs: number): string => new Date(atMs).toLocaleTimeString();

const formatExternalDelivery = (entry: TabDebugExternalEntry): string => {
    if (
        typeof entry.listenerCount !== 'number' ||
        typeof entry.delivered !== 'number' ||
        typeof entry.dropped !== 'number'
    ) {
        return 'listeners: n/a';
    }
    return `listeners: ${entry.listenerCount} | delivered: ${entry.delivered} | dropped: ${entry.dropped}`;
};

const buildEntrySummary = (entry: TabDebugOverlayState['entries'][number], index: number): string => {
    const time = formatTime(entry.atMs);
    if (entry.kind === 'capture') {
        return `${index + 1}. capture | ${entry.conversationId} | source=${entry.source} | ${time}`;
    }
    return `${index + 1}. external:${entry.status} | ${entry.eventType} | ${entry.conversationId} | ${formatExternalDelivery(entry)} | ${time}`;
};

const buildEntryDetailLines = (entry: TabDebugOverlayState['entries'][number]): string[] => {
    if (entry.kind === 'capture') {
        return [
            `conversation_id: ${entry.conversationId}`,
            `attempt_id: ${entry.attemptId ?? 'n/a'}`,
            `source: ${entry.source}`,
            `payload_bytes: ${entry.payloadBytes}`,
        ];
    }
    const lines = [
        `conversation_id: ${entry.conversationId}`,
        `event_type: ${entry.eventType}`,
        `event_id: ${entry.eventId}`,
        `content_hash: ${entry.contentHash ?? 'null'}`,
        formatExternalDelivery(entry),
        `payload_bytes: ${entry.payloadBytes}`,
    ];
    if (entry.error) {
        lines.push(`error: ${entry.error}`);
    }
    return lines;
};

const formatEntry = (entry: TabDebugOverlayState['entries'][number], index: number): string => {
    const timestamp = new Date(entry.atMs).toLocaleTimeString();
    if (entry.kind === 'capture') {
        return [
            `${index + 1}. [capture] @ ${timestamp}`,
            `conversation_id: ${entry.conversationId}`,
            `attempt_id: ${entry.attemptId ?? 'n/a'}`,
            `source: ${entry.source}`,
            `payload_bytes: ${entry.payloadBytes}`,
            'payload:',
            entry.payloadPreview || '{}',
        ].join('\n');
    }
    return [
        `${index + 1}. [external:${entry.status}] @ ${timestamp}`,
        `conversation_id: ${entry.conversationId}`,
        `event_type: ${entry.eventType}`,
        `event_id: ${entry.eventId}`,
        `content_hash: ${entry.contentHash ?? 'null'}`,
        formatExternalDelivery(entry),
        `payload_bytes: ${entry.payloadBytes}`,
        entry.error ? `error: ${entry.error}` : null,
        'payload:',
        entry.payloadPreview || '{}',
    ]
        .filter((line): line is string => !!line)
        .join('\n');
};

export const buildTabDebugOverlayContent = (state: TabDebugOverlayState): string => {
    const lines: string[] = [
        `[Blackiya Tab Debug] captured + emitted payloads`,
        `tab_overlay: ${state.visible ? 'enabled' : 'disabled'}`,
        `records: ${state.entries.length}/${MAX_ENTRIES}`,
        '',
    ];

    if (state.entries.length === 0) {
        lines.push('No captures or external emits recorded in this tab yet.');
        return lines.join('\n');
    }

    for (let i = 0; i < state.entries.length; i += 1) {
        if (i > 0) {
            lines.push('\n------------------------------------------------------------\n');
        }
        lines.push(formatEntry(state.entries[i], i));
    }

    return lines.join('\n');
};

export const buildTabDebugOverlaySnapshot = (state: TabDebugOverlayState): TabDebugOverlaySnapshot => ({
    api: 'blackiya.tab-debug-overlay.v1',
    generatedAtMs: Date.now(),
    visible: state.visible,
    recordCount: state.entries.length,
    maxEntries: MAX_ENTRIES,
    entries: [...state.entries],
    content: buildTabDebugOverlayContent(state),
});

export const ensureTabDebugOverlayPanel = (visible: boolean): HTMLDivElement | null => {
    if (!visible) {
        removeTabDebugOverlayPanel();
        return null;
    }
    const existing = document.getElementById(PANEL_ID) as HTMLDivElement | null;
    if (existing) {
        return existing;
    }

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `
        position: fixed;
        right: 16px;
        top: 16px;
        width: min(560px, calc(100vw - 32px));
        max-height: 70vh;
        overflow: auto;
        z-index: 2147483647;
        background: rgba(2, 6, 23, 0.96);
        color: #dbeafe;
        border: 1px solid rgba(56, 189, 248, 0.5);
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
        font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        padding: 10px;
        word-break: break-word;
        pointer-events: auto;
    `;
    document.body.appendChild(panel);
    return panel;
};

export const renderTabDebugOverlay = (state: TabDebugOverlayState) => {
    const panel = ensureTabDebugOverlayPanel(state.visible);
    if (!panel) {
        return;
    }
    panel.textContent = '';

    const titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.justifyContent = 'space-between';
    titleRow.style.gap = '8px';
    titleRow.style.marginBottom = '8px';

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.textContent = '[Blackiya Tab Debug] captured + emitted payloads';
    titleRow.appendChild(title);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = 'Close';
    closeButton.style.cursor = 'pointer';
    closeButton.style.borderRadius = '6px';
    closeButton.style.border = '1px solid rgba(148, 163, 184, 0.45)';
    closeButton.style.background = 'rgba(15, 23, 42, 0.8)';
    closeButton.style.color = '#e2e8f0';
    closeButton.style.padding = '4px 8px';
    closeButton.style.font = '11px/1.2 ui-sans-serif, system-ui, sans-serif';
    closeButton.onclick = () => {
        state.visible = false;
        persistTabDebugOverlayVisibilityToSession(false);
        removeTabDebugOverlayPanel();
    };
    titleRow.appendChild(closeButton);
    panel.appendChild(titleRow);

    const subTitle = document.createElement('div');
    subTitle.style.fontSize = '11px';
    subTitle.style.color = '#93c5fd';
    subTitle.style.marginBottom = '10px';
    subTitle.textContent = `records: ${state.entries.length}/${MAX_ENTRIES} | newest first`;
    panel.appendChild(subTitle);

    if (state.entries.length === 0) {
        const empty = document.createElement('div');
        empty.style.fontSize = '12px';
        empty.style.color = '#cbd5e1';
        empty.textContent = 'No captures or external emits recorded in this tab yet.';
        panel.appendChild(empty);
        return;
    }

    for (let i = 0; i < state.entries.length; i += 1) {
        const entry = state.entries[i];
        const accordion = document.createElement('details');
        accordion.open = i === 0;
        accordion.style.marginBottom = '8px';
        accordion.style.border = '1px solid rgba(148, 163, 184, 0.35)';
        accordion.style.borderRadius = '8px';
        accordion.style.background = 'rgba(15, 23, 42, 0.55)';

        const summary = document.createElement('summary');
        summary.style.cursor = 'pointer';
        summary.style.padding = '8px 10px';
        summary.style.fontWeight = '600';
        summary.style.userSelect = 'text';
        summary.textContent = buildEntrySummary(entry, i);
        accordion.appendChild(summary);

        const body = document.createElement('div');
        body.style.padding = '8px 10px 10px 10px';
        body.style.borderTop = '1px solid rgba(148, 163, 184, 0.25)';

        const meta = document.createElement('pre');
        meta.style.margin = '0 0 8px 0';
        meta.style.whiteSpace = 'pre-wrap';
        meta.style.color = '#bfdbfe';
        meta.textContent = buildEntryDetailLines(entry).join('\n');
        body.appendChild(meta);

        const payloadLabel = document.createElement('div');
        payloadLabel.style.fontWeight = '600';
        payloadLabel.style.marginBottom = '4px';
        payloadLabel.textContent = 'payload';
        body.appendChild(payloadLabel);

        const payload = document.createElement('pre');
        payload.style.margin = '0';
        payload.style.whiteSpace = 'pre-wrap';
        payload.style.maxHeight = '240px';
        payload.style.overflow = 'auto';
        payload.style.padding = '8px';
        payload.style.background = 'rgba(2, 6, 23, 0.7)';
        payload.style.border = '1px solid rgba(148, 163, 184, 0.25)';
        payload.style.borderRadius = '6px';
        payload.textContent = entry.payloadPreview || '{}';
        body.appendChild(payload);

        accordion.appendChild(body);
        panel.appendChild(accordion);
    }
};

export const removeTabDebugOverlayPanel = () => {
    const panel = document.getElementById(PANEL_ID);
    if (panel?.parentNode) {
        panel.parentNode.removeChild(panel);
    }
};
