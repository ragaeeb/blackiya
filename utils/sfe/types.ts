import type { ConversationData } from '@/utils/types';

export type LifecyclePhase =
    | 'idle'
    | 'prompt_sent'
    | 'streaming'
    | 'completed_hint'
    | 'canonical_probing'
    | 'captured_ready'
    | 'terminated_partial'
    | 'error'
    | 'superseded'
    | 'disposed';

export type SignalSource =
    | 'network_stream'
    | 'completion_endpoint'
    | 'canonical_fetch'
    | 'dom_hint'
    | 'snapshot_fallback';

export interface PlatformReadiness {
    ready: boolean;
    terminal: boolean;
    reason: string;
    contentHash: string | null;
    latestAssistantTextLength: number;
}

export interface FusionSignal {
    attemptId: string;
    platform: string;
    source: SignalSource;
    phase: LifecyclePhase;
    conversationId?: string | null;
    platformGenerationId?: string | null;
    timestampMs: number;
    sequenceNo?: number;
    meta?: {
        statusCode?: number;
        terminal?: boolean;
        reasonCode?:
            | 'completed_hint_received'
            | 'awaiting_second_sample'
            | 'stability_window_not_elapsed'
            | 'content_hash_changed'
            | 'canonical_not_terminal'
            | 'probe_timeout'
            | 'probe_canceled'
            | 'legacy_message_path';
    };
}

export type BlockingCondition =
    | 'no_canonical_data'
    | 'canonical_not_terminal'
    | 'awaiting_second_sample'
    | 'stability_window_not_elapsed'
    | 'content_hash_changed'
    | 'generation_superseded'
    | 'disposed'
    | 'platform_generating';

export interface CaptureResolution {
    attemptId: string;
    platform: string;
    conversationId?: string | null;
    platformGenerationId?: string | null;
    phase: LifecyclePhase;
    ready: boolean;
    reason: 'not_captured' | 'captured_not_ready' | 'awaiting_stabilization' | 'ready' | 'terminated_partial' | 'error';
    blockingConditions: BlockingCondition[];
    updatedAtMs: number;
}

export interface AttemptDescriptor {
    attemptId: string;
    platform: string;
    createdAtMs: number;
    updatedAtMs: number;
    conversationId?: string | null;
    platformGenerationId?: string | null;
    phase: LifecyclePhase;
    supersededByAttemptId?: string;
    disposed: boolean;
}

export interface CanonicalSample {
    attemptId: string;
    platform: string;
    conversationId?: string | null;
    data: ConversationData;
    readiness: PlatformReadiness;
    timestampMs: number;
}
