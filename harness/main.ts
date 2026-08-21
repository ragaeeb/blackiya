import { createChatGPTAdapter } from '@/platforms/chatgpt';
import type { PlatformReadiness } from '@/platforms/types';
import { processInterceptionCapture, type InterceptionCaptureDeps } from '@/utils/runner/interception-capture';
import { processFinishedConversation, type ResponseFinishedDeps } from '@/utils/runner/response-finished-handler';
import {
    handleForceSaveJsonClick,
    handleSaveClick,
    handleSaveMarkdownClick,
    type SavePipelineDeps,
} from '@/utils/runner/save-pipeline';
import type { RawCaptureSnapshot } from '@/utils/runner/calibration-capture';
import type { RunnerLifecycleUiState } from '@/utils/runner/state';
import type { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import type { ExportMeta, ReadinessDecision } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';
import { ButtonManager } from '@/utils/ui/button-manager';
import { HARNESS_CONVERSATION_ID, simulateChatGPTArtifactDownload } from './fixture';
import { warmFetchConversationSnapshot, type WarmFetchDeps } from '@/utils/runner/warm-fetch';

const target = <T extends Element>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) {
        throw new Error(`Harness element not found: ${selector}`);
    }
    return element;
};

const defaultCaptureMeta = (): ExportMeta => ({
    captureSource: 'canonical_api',
    fidelity: 'high',
    completeness: 'complete',
});

const isConversationDataLike = (value: unknown): value is ConversationData => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<ConversationData>;
    return typeof candidate.conversation_id === 'string' && !!candidate.mapping;
};

const isRawCaptureSnapshot = (value: unknown): value is RawCaptureSnapshot => {
    return false;
};

const structuredLogger = { emit: () => undefined } as unknown as StructuredAttemptLogger;

class BrowserHarness {
    private readonly adapter = createChatGPTAdapter();
    private readonly conversations = new Map<string, ConversationData>();
    private readonly captureMetaByConversation = new Map<string, ExportMeta>();
    private readonly attemptByConversation = new Map<string, string>();
    private readonly warmFetchInFlight = new Map<string, Promise<boolean>>();
    private readonly aliases = new Map<string, string>();
    private readonly logElement = target<HTMLDivElement>('#harness-event-log');
    private readonly lifecycleElement = target<HTMLSpanElement>('#harness-lifecycle');
    private readonly saveStateElement = target<HTMLSpanElement>('#harness-save-state');
    private readonly forceStateElement = target<HTMLSpanElement>('#harness-force-state');
    private readonly cacheStateElement = target<HTMLSpanElement>('#harness-cache-state');
    private readonly downloadElement = target<HTMLParagraphElement>('#harness-download-output');
    private readonly buttonManager = new ButtonManager(
        () => handleSaveClick(this.savePipelineDeps),
        () => handleSaveMarkdownClick(this.savePipelineDeps),
        async () => this.log('Calibration is not needed for this canonical fixture.'),
        () => handleForceSaveJsonClick(this.savePipelineDeps),
    );
    private readonly warmFetchDeps: WarmFetchDeps;
    private readonly interceptionCaptureDeps: InterceptionCaptureDeps;
    private readonly responseFinishedDeps: ResponseFinishedDeps;
    private readonly savePipelineDeps: SavePipelineDeps;
    private lifecycleState: RunnerLifecycleUiState = 'idle';
    private currentConversationId: string | null = HARNESS_CONVERSATION_ID;
    private activeAttemptId = 'harness:initial-load';
    private lastResponseFinishedAt = 0;
    private lastResponseFinishedConversationId: string | null = null;
    private lastResponseFinishedAttemptId: string | null = null;

    public constructor() {
        this.warmFetchDeps = {
            platformName: 'ChatGPT',
            getFetchUrlCandidates: (conversationId) => [
                `${window.location.origin}/backend-api/conversation/${conversationId}`,
            ],
            ingestInterceptedData: ({ url, data, platform }) => this.ingestRawCapture({ url, data, platform }),
            getConversation: (conversationId) => this.conversations.get(conversationId) ?? null,
            evaluateReadiness: (data) => this.evaluateReadiness(data),
            getCaptureMeta: (conversationId) =>
                this.captureMetaByConversation.get(conversationId) ?? defaultCaptureMeta(),
            isConversationCurrent: (conversationId) => this.currentConversationId === conversationId,
        };

        this.interceptionCaptureDeps = {
            getStreamResolvedTitle: () => undefined,
            setCurrentConversation: (conversationId) => {
                this.currentConversationId = conversationId;
                this.render();
            },
            setActiveAttempt: (attemptId) => {
                if (attemptId) {
                    this.activeAttemptId = attemptId;
                }
            },
            bindAttempt: (conversationId, attemptId) => {
                if (conversationId) {
                    this.attemptByConversation.set(conversationId, attemptId);
                }
            },
            peekAttemptId: (conversationId) =>
                (conversationId ? this.attemptByConversation.get(conversationId) : null) ?? this.activeAttemptId,
            resolveAttemptId: (conversationId) => {
                const existing = conversationId ? this.attemptByConversation.get(conversationId) : undefined;
                if (existing) {
                    return existing;
                }
                const created = this.activeAttemptId || `harness:${Date.now()}`;
                if (conversationId) {
                    this.attemptByConversation.set(conversationId, created);
                }
                return created;
            },
            resolveAliasedAttemptId: (attemptId) => this.aliases.get(attemptId) ?? attemptId,
            evaluateReadinessForData: (data) => this.evaluateReadiness(data),
            resolveReadinessDecision: (conversationId) => this.resolveReadinessDecision(conversationId),
            markSnapshotCaptureMeta: (conversationId) => {
                this.captureMetaByConversation.set(conversationId, {
                    captureSource: 'dom_snapshot_degraded',
                    fidelity: 'degraded',
                    completeness: 'partial',
                });
            },
            markCanonicalCaptureMeta: (conversationId) => {
                this.captureMetaByConversation.set(conversationId, defaultCaptureMeta());
            },
            ingestSfeCanonicalSample: () => undefined,
            maybeRestartCanonicalRecoveryAfterTimeout: () => undefined,
            scheduleCanonicalStabilizationRetry: () => undefined,
            refreshButtonState: (conversationId) => this.refreshButtonState(conversationId),
            handleResponseFinished: (source, conversationId) => {
                const resolvedConversationId = conversationId ?? this.currentConversationId;
                if (resolvedConversationId) {
                    processFinishedConversation(
                        resolvedConversationId,
                        this.activeAttemptId,
                        source,
                        this.responseFinishedDeps,
                    );
                }
            },
            getLifecycleState: () => this.lifecycleState,
            structuredLogger,
        };

        this.responseFinishedDeps = {
            extractConversationIdFromUrl: () => this.currentConversationId,
            getCurrentConversationId: () => this.currentConversationId,
            peekAttemptId: (conversationId) =>
                (conversationId ? this.attemptByConversation.get(conversationId) : null) ?? this.activeAttemptId,
            resolveAttemptId: (conversationId) => this.interceptionCaptureDeps.resolveAttemptId(conversationId),
            setActiveAttempt: (attemptId) => {
                this.activeAttemptId = attemptId;
            },
            setCurrentConversation: (conversationId) => {
                this.currentConversationId = conversationId;
            },
            bindAttempt: (conversationId, attemptId) => {
                this.attemptByConversation.set(conversationId, attemptId);
            },
            ingestSfeLifecycle: () => undefined,
            getCalibrationState: () => 'idle',
            shouldBlockActionsForGeneration: () => false,
            adapterName: () => 'ChatGPT',
            getLastResponseFinished: () => ({
                at: this.lastResponseFinishedAt,
                conversationId: this.lastResponseFinishedConversationId,
                attemptId: this.lastResponseFinishedAttemptId,
            }),
            setLastResponseFinished: (at, conversationId, attemptId) => {
                this.lastResponseFinishedAt = at;
                this.lastResponseFinishedConversationId = conversationId;
                this.lastResponseFinishedAttemptId = attemptId;
            },
            getConversation: (conversationId) => this.conversations.get(conversationId),
            evaluateReadiness: (data) => this.evaluateReadiness(data),
            getLifecycleState: () => this.lifecycleState,
            setCompletedLifecycleState: (conversationId, attemptId) => {
                this.activeAttemptId = attemptId;
                this.lifecycleState = 'completed';
                this.buttonManager.setLifecycleState('completed');
                this.log(`Canonical history promoted lifecycle to Completed for ${conversationId}.`);
            },
            runStreamDoneProbe: async () => undefined,
            refreshButtonState: (conversationId) => this.refreshButtonState(conversationId),
            scheduleButtonRefresh: (conversationId) => this.refreshButtonState(conversationId),
            maybeRunAutoCapture: () => undefined,
        };

        this.savePipelineDeps = {
            getAdapter: () => this.adapter,
            resolveConversationIdForUserAction: () => this.currentConversationId,
            getConversation: (conversationId) => this.conversations.get(conversationId),
            resolveReadinessDecision: (conversationId) => this.resolveReadinessDecision(conversationId),
            shouldBlockActionsForGeneration: () => false,
            getCaptureMeta: (conversationId) =>
                this.captureMetaByConversation.get(conversationId) ?? defaultCaptureMeta(),
            getStreamResolvedTitle: () => null,
            evaluateReadinessForData: (data) => this.evaluateReadiness(data),
            markCanonicalCaptureMeta: (conversationId) => {
                this.captureMetaByConversation.set(conversationId, defaultCaptureMeta());
            },
            ingestSfeCanonicalSample: () => undefined,
            resolveAttemptId: (conversationId) => this.interceptionCaptureDeps.resolveAttemptId(conversationId),
            peekAttemptId: (conversationId) => this.interceptionCaptureDeps.peekAttemptId(conversationId),
            refreshButtonState: (conversationId) => this.refreshButtonState(conversationId),
            requestPageSnapshot: async () => null,
            warmFetchConversationSnapshot: (conversationId, reason) =>
                warmFetchConversationSnapshot(conversationId, reason, this.warmFetchDeps, this.warmFetchInFlight),
            ingestConversationData: (data) => {
                this.conversations.set(data.conversation_id, data);
                processInterceptionCapture(
                    data.conversation_id,
                    data,
                    { source: 'network', attemptId: this.activeAttemptId },
                    this.interceptionCaptureDeps,
                );
            },
            isConversationDataLike,
            isRawCaptureSnapshot,
            ingestInterceptedData: ({ url, data, platform }) => this.ingestRawCapture({ url, data, platform }),
            getRawSnapshotReplayUrls: () => [],
            getPlatformName: () => 'ChatGPT',
            buttonManagerSetLoading: (loading, action) => this.buttonManager.setLoading(loading, action),
            buttonManagerSetSuccess: (action) => this.buttonManager.setSuccess(action),
            downloadJson: (data, filename) => {
                this.downloadElement.textContent = `JSON export ready: ${filename}.json (${JSON.stringify(data).length} bytes)`;
            },
            downloadMarkdown: (markdown, filename) => {
                this.downloadElement.textContent = `Markdown export ready: ${filename}.md (${markdown.length} bytes)`;
            },
            structuredLogger,
        };
    }

    public mount() {
        window.confirm = () => true;
        target<HTMLButtonElement>('#harness-reset').addEventListener('click', () => this.startInitialLoad());
        target<HTMLButtonElement>('#harness-page-capture').addEventListener('click', () => {
            void this.deliverPageOwnedCapture();
        });
        target<HTMLButtonElement>('#harness-download-file').addEventListener('click', () => {
            this.openArtifactPreview();
        });
        this.startInitialLoad();
    }

    private async startInitialLoad() {
        this.conversations.clear();
        this.captureMetaByConversation.clear();
        this.attemptByConversation.clear();
        this.warmFetchInFlight.clear();
        this.currentConversationId = HARNESS_CONVERSATION_ID;
        this.activeAttemptId = `harness:initial-load:${Date.now()}`;
        this.lifecycleState = 'idle';
        this.buttonManager.remove();
        this.buttonManager.inject(document.body, HARNESS_CONVERSATION_ID);
        this.buttonManager.setLifecycleState('idle');
        this.buttonManager.setActionButtonsEnabled(false);
        this.downloadElement.textContent = '';
        this.log('Reloaded: page-owned capture is intentionally absent. Lifecycle is Idle.');
        this.render();

        const success = await warmFetchConversationSnapshot(
            HARNESS_CONVERSATION_ID,
            'initial-load',
            this.warmFetchDeps,
            this.warmFetchInFlight,
        );
        this.log(success ? 'Warm-fetch recovery captured the finished history.' : 'Warm-fetch recovery did not capture history.');
        this.render();
    }

    private openArtifactPreview() {
        simulateChatGPTArtifactDownload(document);
        this.log('Download review-ledger.json opened the artifact preview and replaced the page-owned header host.');
        this.render();
    }

    private async deliverPageOwnedCapture() {
        this.log('Delivering a page-owned canonical capture during the grace window.');
        const url = `${window.location.origin}/backend-api/conversation/${HARNESS_CONVERSATION_ID}`;
        const response = await fetch(url);
        this.ingestRawCapture({ url, data: await response.text(), platform: 'ChatGPT' });
        this.log('Page-owned capture delivered; the warm fetch should deduplicate it.');
    }

    private ingestRawCapture({ url, data, platform }: { url: string; data: string; platform: string }) {
        const parsed = this.adapter.parseInterceptedData(data, url);
        if (!parsed) {
            this.log('Adapter could not parse the harness response.');
            return;
        }
        this.conversations.set(parsed.conversation_id, parsed);
        processInterceptionCapture(
            parsed.conversation_id,
            parsed,
            { source: 'network', attemptId: this.activeAttemptId },
            this.interceptionCaptureDeps,
        );
        this.log(`ChatGPT adapter captured ${platform} history as canonical data.`);
    }

    private evaluateReadiness(data: ConversationData): PlatformReadiness {
        return this.adapter.evaluateReadiness?.(data) ?? {
            ready: false,
            terminal: false,
            reason: 'adapter-readiness-missing',
            contentHash: null,
            latestAssistantTextLength: 0,
        };
    }

    private resolveReadinessDecision(conversationId: string): ReadinessDecision {
        const data = this.conversations.get(conversationId);
        const readiness = data ? this.evaluateReadiness(data) : null;
        const meta = this.captureMetaByConversation.get(conversationId);
        if (data && readiness?.ready && meta?.fidelity !== 'degraded') {
            return { ready: true, mode: 'canonical_ready', reason: readiness.reason };
        }
        if (data && readiness?.ready && meta?.fidelity === 'degraded') {
            return { ready: true, mode: 'degraded_manual_only', reason: 'degraded-capture' };
        }
        return { ready: false, mode: 'awaiting_stabilization', reason: readiness?.reason ?? 'not-captured' };
    }

    private refreshButtonState(conversationId: string | undefined) {
        const id = conversationId ?? this.currentConversationId;
        const enabled =
            !!id &&
            this.lifecycleState === 'completed' &&
            this.resolveReadinessDecision(id).mode === 'canonical_ready';
        this.buttonManager.setActionButtonsEnabled(enabled);
        this.render();
    }

    private render() {
        this.lifecycleElement.textContent = this.lifecycleState === 'completed' ? 'Completed' : 'Idle';
        const saveButton = document.querySelector<HTMLButtonElement>('#blackiya-save-btn');
        const forceButton = document.querySelector<HTMLButtonElement>('#blackiya-force-save-json-btn');
        this.saveStateElement.textContent = saveButton?.disabled === false ? 'Enabled' : 'Disabled';
        this.forceStateElement.textContent = forceButton?.disabled === false ? 'Enabled' : 'Disabled';
        this.cacheStateElement.textContent = this.conversations.has(HARNESS_CONVERSATION_ID) ? 'Canonical' : 'Empty';
    }

    private log(message: string) {
        const timestamp = new Date().toLocaleTimeString();
        this.logElement.textContent = `${this.logElement.textContent}${this.logElement.textContent ? '\n' : ''}[${timestamp}] ${message}`;
        this.logElement.scrollTop = this.logElement.scrollHeight;
    }
}

new BrowserHarness().mount();
