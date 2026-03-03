import type { ExternalConversationEvent, ExternalInboundConversationEvent } from '@/utils/external-api/contracts';

export type ExternalPortLike = {
    name: string;
    postMessage: (message: unknown) => void;
    disconnect?: () => void;
    onMessage?: {
        addListener: (listener: (message: unknown) => void) => void;
        removeListener?: (listener: (message: unknown) => void) => void;
    };
    onDisconnect: {
        addListener: (listener: (port: ExternalPortLike) => void) => void;
        removeListener?: (listener: (port: ExternalPortLike) => void) => void;
    };
};

export type CachedConversationRecord = {
    conversation_id: string;
    provider: ExternalConversationEvent['provider'];
    event_id?: string;
    event_type?: ExternalConversationEvent['type'];
    payload: ExternalConversationEvent['payload'];
    attempt_id?: string | null;
    capture_meta: ExternalConversationEvent['capture_meta'];
    content_hash: string | null;
    ts: number;
    tab_id?: number;
};

export type ExternalEventDeliveryStats = {
    subscriberCount: number;
    delivered: number;
    dropped: number;
};

export type ExternalEventStore = {
    init: () => Promise<void>;
    append: (event: ExternalInboundConversationEvent) => Promise<ExternalConversationEvent>;
    getSince: (cursor: number, limit: number) => Promise<ExternalConversationEvent[]>;
    getHeadSeq: () => Promise<number>;
    getLatest: (tabId?: number) => Promise<ExternalConversationEvent | null>;
    getByConversationId: (conversationId: string) => Promise<ExternalConversationEvent | null>;
    ensureDeliveryConsumer: (consumerId: string) => Promise<{ designatedConsumerId: string; authorized: boolean }>;
    getDeliveryConsumerId: () => Promise<string | null>;
    commit: (consumerId: string, upToSeq: number) => Promise<{ committedSeq: number; authorized: boolean }>;
    prune: () => Promise<{ deleted: number; total: number; blockedByUncommitted: boolean }>;
    getLastWakeSentAt: () => Promise<number>;
    setLastWakeSentAt: (ts: number) => Promise<void>;
};
