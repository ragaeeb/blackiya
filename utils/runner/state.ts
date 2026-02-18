import type { LLMPlatform } from '@/platforms/types';
import type { ExportMeta } from '@/utils/sfe/types';

export type RunnerLifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';
export type RunnerCalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';

/**
 * Lightweight shared state container for extracted runner modules.
 * The full migration is incremental; this shape provides a typed anchor.
 */
export class RunnerState {
    public adapter: LLMPlatform | null = null;
    public conversationId: string | null = null;
    public lifecycleState: RunnerLifecycleUiState = 'idle';
    public calibrationState: RunnerCalibrationUiState = 'idle';
    public activeAttemptId: string | null = null;

    public readonly attemptByConversation = new Map<string, string>();
    public readonly attemptAliasForward = new Map<string, string>();
    public readonly streamPreviewByConversation = new Map<string, string>();
    public readonly captureMetaByConversation = new Map<string, ExportMeta>();
}
