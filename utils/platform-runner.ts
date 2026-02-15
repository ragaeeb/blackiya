/**
 * Platform Runner Utility
 *
 * Orchestrator that ties together the specialized managers for:
 * - UI (ButtonManager)
 * - Data (InterceptionManager)
 * - Navigation (NavigationManager)
 *
 * @module utils/platform-runner
 */

import { browser } from 'wxt/browser';
import { getPlatformAdapter } from '@/platforms/factory';
import type { LLMPlatform } from '@/platforms/types';
import {
    buildLegacyAttemptId,
    isLegacyFinishedMessage,
    isLegacyLifecycleMessage,
    isLegacyStreamDeltaMessage,
    type AttemptDisposedMessage,
    type ConversationIdResolvedMessage,
    type ResponseFinishedMessage,
    type ResponseLifecycleMessage,
    type StreamDeltaMessage,
} from '@/utils/protocol/messages';
import { buildCommonExport } from '@/utils/common-export';
import { isConversationReady } from '@/utils/conversation-readiness';
import { downloadAsJSON } from '@/utils/download';
import { logger } from '@/utils/logger';
import { loadCalibrationProfileV2, saveCalibrationProfileV2 } from '@/utils/calibration-profile';
import { StructuredAttemptLogger } from '@/utils/logging/structured-logger';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { NavigationManager } from '@/utils/managers/navigation-manager';
import { DEFAULT_EXPORT_FORMAT, type ExportFormat, STORAGE_KEYS } from '@/utils/settings';
import { SignalFusionEngine } from '@/utils/sfe/signal-fusion-engine';
import type { LifecyclePhase, PlatformReadiness } from '@/utils/sfe/types';
import type { ConversationData } from '@/utils/types';
import { ButtonManager } from '@/utils/ui/button-manager';

interface SnapshotMessageCandidate {
    role: 'user' | 'assistant';
    text: string;
}

type CalibrationStep = 'queue-flush' | 'passive-wait' | 'endpoint-retry' | 'page-snapshot';
type CalibrationMode = 'manual' | 'auto';
type LifecycleUiState = 'idle' | 'prompt-sent' | 'streaming' | 'completed';

interface LegacyCalibrationProfile {
    preferredStep: CalibrationStep;
    updatedAt: string;
}

type LegacyCalibrationProfilesStore = Record<string, LegacyCalibrationProfile>;
type CalibrationUiState = 'idle' | 'waiting' | 'capturing' | 'success' | 'error';
const SFE_ENABLED = false;
const SFE_SHADOW_ENABLED = true;

export function buildCalibrationOrderForMode(
    preferredStep: CalibrationStep | null,
    mode: CalibrationMode,
    platformName?: string,
): CalibrationStep[] {
    const defaultOrder: CalibrationStep[] = ['queue-flush', 'passive-wait', 'endpoint-retry', 'page-snapshot'];
    if (!preferredStep) {
        return defaultOrder;
    }

    if (mode === 'auto' && preferredStep === 'page-snapshot') {
        // For ChatGPT, snapshot fallback is currently the most reliable and avoids long endpoint-retry delays.
        if (platformName === 'ChatGPT') {
            return ['queue-flush', 'page-snapshot', 'passive-wait', 'endpoint-retry'];
        }
        return defaultOrder;
    }

    const reordered = [preferredStep, ...defaultOrder.filter((step) => step !== preferredStep)];
    if (mode !== 'auto') {
        return reordered;
    }

    // In auto mode, keep page-snapshot as a last resort to reduce premature partial captures.
    const withoutSnapshot = reordered.filter((step) => step !== 'page-snapshot');
    return [...withoutSnapshot, 'page-snapshot'];
}

export function shouldPersistCalibrationProfile(mode: CalibrationMode): boolean {
    return mode === 'manual';
}

function preferredStepFromStrategy(strategy: 'aggressive' | 'balanced' | 'conservative'): CalibrationStep {
    if (strategy === 'aggressive') {
        return 'passive-wait';
    }
    if (strategy === 'balanced') {
        return 'endpoint-retry';
    }
    return 'queue-flush';
}

function strategyFromPreferredStep(step: CalibrationStep): 'aggressive' | 'balanced' | 'conservative' {
    if (step === 'passive-wait') {
        return 'aggressive';
    }
    if (step === 'endpoint-retry') {
        return 'balanced';
    }
    return 'conservative';
}

function normalizeContentText(text: string): string {
    return text.trim().normalize('NFC');
}

function hashText(value: string): string {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (hash << 5) - hash + value.charCodeAt(i);
        hash |= 0;
    }
    return `${hash}`;
}

export function runPlatform(): void {
    let currentAdapter: LLMPlatform | null = null;
    let currentConversationId: string | null = null;
    let cleanupWindowBridge: (() => void) | null = null;
    let cleanupCompletionWatcher: (() => void) | null = null;
    let cleanupButtonHealthCheck: (() => void) | null = null;
    let lastButtonStateLog = '';
    let calibrationState: CalibrationUiState = 'idle';
    let lifecycleState: LifecycleUiState = 'idle';
    let lastStreamProbeKey = '';
    const liveStreamPreviewByConversation = new Map<string, string>();
    let lastResponseFinishedAt = 0;
    let lastResponseFinishedConversationId: string | null = null;
    let rememberedPreferredStep: CalibrationStep | null = null;
    let rememberedCalibrationUpdatedAt: string | null = null;
    let calibrationPreferenceLoaded = false;
    let calibrationPreferenceLoading: Promise<void> | null = null;
    const autoCaptureAttempts = new Map<string, number>();
    const autoCaptureRetryTimers = new Map<string, number>();
    const autoCaptureDeferredLogged = new Set<string>();
    const sfe = new SignalFusionEngine();
    const structuredLogger = new StructuredAttemptLogger();
    const attemptByConversation = new Map<string, string>();
    let activeAttemptId: string | null = null;

    // -- Manager Initialization --

    // 1. UI Manager
    const buttonManager = new ButtonManager(handleSaveClick, handleCopyClick, handleCalibrationClick);

    // 2. Data Manager
    const interceptionManager = new InterceptionManager((capturedId, data, meta) => {
        currentConversationId = capturedId;
        if (meta?.attemptId) {
            activeAttemptId = meta.attemptId;
            bindAttempt(capturedId, meta.attemptId);
        }
        ingestSfeCanonicalSample(data, meta?.attemptId);
        refreshButtonState(capturedId);
        if (isConversationReady(data)) {
            handleResponseFinished('network', capturedId);
        }
    });

    // 3. Navigation Manager
    const navigationManager = new NavigationManager(() => {
        handleNavigationChange();
    });

    /**
     * Core orchestrator logic functions
     */
    async function getExportFormat(): Promise<ExportFormat> {
        try {
            const result = await browser.storage.local.get(STORAGE_KEYS.EXPORT_FORMAT);
            const value = result[STORAGE_KEYS.EXPORT_FORMAT];
            if (value === 'common' || value === 'original') {
                return value;
            }
        } catch (error) {
            logger.warn('Failed to read export format setting, using default.', error);
        }
        return DEFAULT_EXPORT_FORMAT;
    }

    function resolveAttemptId(conversationId?: string): string {
        if (conversationId) {
            const mapped = attemptByConversation.get(conversationId);
            if (mapped) {
                return mapped;
            }
        }
        if (activeAttemptId) {
            return activeAttemptId;
        }
        const platformName = currentAdapter?.name ?? 'Unknown';
        return buildLegacyAttemptId(platformName, conversationId);
    }

    function bindAttempt(conversationId: string | undefined, attemptId: string): void {
        if (!conversationId) {
            return;
        }
        const previous = attemptByConversation.get(conversationId);
        if (previous && previous !== attemptId) {
            sfe.getAttemptTracker().markSuperseded(previous, attemptId);
            emitAttemptDisposed(previous, 'superseded');
            structuredLogger.emit(
                previous,
                'info',
                'attempt_superseded',
                'Attempt superseded by newer prompt',
                { conversationId, supersededBy: attemptId },
                `supersede:${conversationId}:${attemptId}`,
            );
        }
        attemptByConversation.set(conversationId, attemptId);
    }

    function evaluateReadinessForData(data: ConversationData): PlatformReadiness {
        if (!data || !data.mapping || typeof data.mapping !== 'object') {
            return {
                ready: false,
                terminal: false,
                reason: 'invalid-conversation-shape',
                contentHash: null,
                latestAssistantTextLength: 0,
            };
        }

        if (currentAdapter?.evaluateReadiness) {
            return currentAdapter.evaluateReadiness(data);
        }

        const assistantMessages = Object.values(data.mapping)
            .map((node) => node?.message)
            .filter((message): message is NonNullable<(typeof data.mapping)[string]['message']> => !!message)
            .filter((message) => message.author.role === 'assistant');

        const latestAssistant = assistantMessages[assistantMessages.length - 1];
        const text = normalizeContentText((latestAssistant?.content.parts ?? []).join(''));
        const hasInProgress = assistantMessages.some((message) => message.status === 'in_progress');
        const terminal = !hasInProgress;

        return {
            ready: isConversationReady(data),
            terminal,
            reason: terminal ? 'terminal-snapshot' : 'assistant-in-progress',
            contentHash: text.length > 0 ? hashText(text) : null,
            latestAssistantTextLength: text.length,
        };
    }

    function ingestSfeLifecycle(phase: LifecyclePhase, attemptId: string, conversationId?: string | null): void {
        if (!SFE_SHADOW_ENABLED) {
            return;
        }
        const resolution = sfe.ingestSignal({
            attemptId,
            platform: currentAdapter?.name ?? 'Unknown',
            source: phase === 'completed_hint' ? 'completion_endpoint' : 'network_stream',
            phase,
            conversationId,
            timestampMs: Date.now(),
        });
        if (conversationId) {
            bindAttempt(conversationId, attemptId);
        }
        if (phase === 'completed_hint') {
            structuredLogger.emit(
                attemptId,
                'info',
                'completed_hint_received',
                'SFE completed hint received',
                { conversationId: conversationId ?? null },
                `completed:${conversationId ?? 'unknown'}`,
            );
        }
        structuredLogger.emit(
            attemptId,
            'debug',
            'sfe_phase_update',
            'SFE lifecycle phase update',
            { phase: resolution.phase, ready: resolution.ready, conversationId: conversationId ?? null },
            `phase:${resolution.phase}:${conversationId ?? 'unknown'}`,
        );
    }

    function ingestSfeCanonicalSample(data: ConversationData, attemptId?: string): void {
        if (!SFE_SHADOW_ENABLED) {
            return;
        }
        const conversationId = data.conversation_id;
        const effectiveAttemptId = attemptId ?? resolveAttemptId(conversationId);
        bindAttempt(conversationId, effectiveAttemptId);
        const readiness = evaluateReadinessForData(data);
        const resolution = sfe.applyCanonicalSample({
            attemptId: effectiveAttemptId,
            platform: currentAdapter?.name ?? 'Unknown',
            conversationId,
            data,
            readiness,
            timestampMs: Date.now(),
        });

        structuredLogger.emit(
            effectiveAttemptId,
            'debug',
            readiness.contentHash ? 'canonical_probe_sample_changed' : 'canonical_probe_started',
            'SFE canonical sample processed',
            {
                conversationId,
                phase: resolution.phase,
                ready: resolution.ready,
                blockingConditions: resolution.blockingConditions,
            },
            `canonical:${conversationId}:${readiness.contentHash ?? 'none'}`,
        );
    }

    function resolveSfeReady(conversationId: string): boolean {
        const resolution = sfe.resolveByConversation(conversationId);
        return !!resolution?.ready;
    }

    function logSfeMismatchIfNeeded(conversationId: string, legacyReady: boolean): void {
        if (!SFE_SHADOW_ENABLED) {
            return;
        }
        const attemptId = resolveAttemptId(conversationId);
        const sfeReady = resolveSfeReady(conversationId);
        if (legacyReady === sfeReady) {
            return;
        }
        structuredLogger.emit(
            attemptId,
            'info',
            'legacy_sfe_mismatch',
            'Legacy/SFE readiness mismatch',
            { conversationId, legacyReady, sfeReady },
            `mismatch:${conversationId}:${legacyReady}:${sfeReady}`,
        );
    }

    function emitAttemptDisposed(attemptId: string, reason: AttemptDisposedMessage['reason']): void {
        const payload: AttemptDisposedMessage = {
            type: 'BLACKIYA_ATTEMPT_DISPOSED',
            attemptId,
            reason,
        };
        window.postMessage(payload, window.location.origin);
    }

    async function loadCalibrationPreference(platformName: string): Promise<void> {
        try {
            const result = await browser.storage.local.get(STORAGE_KEYS.CALIBRATION_PROFILES);
            const rawStore = result[STORAGE_KEYS.CALIBRATION_PROFILES] as
                | (LegacyCalibrationProfilesStore & Record<string, unknown>)
                | undefined;
            const legacyStore = rawStore ?? {};
            const legacyProfile = legacyStore[platformName];

            if (legacyProfile?.preferredStep) {
                rememberedPreferredStep = legacyProfile.preferredStep;
                rememberedCalibrationUpdatedAt = legacyProfile.updatedAt ?? null;
            } else {
                const maybeV2 = rawStore?.[platformName];
                if (maybeV2 && typeof maybeV2 === 'object') {
                    const profileV2 = await loadCalibrationProfileV2(platformName);
                    rememberedPreferredStep = preferredStepFromStrategy(profileV2.strategy);
                    rememberedCalibrationUpdatedAt = profileV2.updatedAt;
                } else {
                    rememberedPreferredStep = null;
                    rememberedCalibrationUpdatedAt = null;
                }
            }

            calibrationPreferenceLoaded = true;
            syncCalibrationButtonDisplay();
        } catch (error) {
            logger.warn('Failed to load calibration profile', error);
            calibrationPreferenceLoaded = true;
            syncCalibrationButtonDisplay();
        }
    }

    function ensureCalibrationPreferenceLoaded(platformName: string): Promise<void> {
        if (calibrationPreferenceLoaded) {
            return Promise.resolve();
        }

        if (calibrationPreferenceLoading) {
            return calibrationPreferenceLoading;
        }

        calibrationPreferenceLoading = loadCalibrationPreference(platformName).finally(() => {
            calibrationPreferenceLoading = null;
        });
        return calibrationPreferenceLoading;
    }

    async function rememberCalibrationSuccess(platformName: string, step: CalibrationStep): Promise<void> {
        try {
            const result = await browser.storage.local.get(STORAGE_KEYS.CALIBRATION_PROFILES);
            const store = (result[STORAGE_KEYS.CALIBRATION_PROFILES] as LegacyCalibrationProfilesStore | undefined) ?? {};
            store[platformName] = {
                preferredStep: step,
                updatedAt: new Date().toISOString(),
            };
            rememberedPreferredStep = step;
            rememberedCalibrationUpdatedAt = store[platformName]?.updatedAt ?? null;
            calibrationPreferenceLoaded = true;
            await browser.storage.local.set({
                [STORAGE_KEYS.CALIBRATION_PROFILES]: store,
            });

            await saveCalibrationProfileV2({
                schemaVersion: 2,
                platform: platformName,
                strategy: strategyFromPreferredStep(step),
                disabledSources: ['dom_hint', 'snapshot_fallback'],
                timingsMs: {
                    passiveWait: step === 'passive-wait' ? 900 : step === 'endpoint-retry' ? 1400 : 2200,
                    domQuietWindow: step === 'passive-wait' ? 500 : 800,
                    maxStabilizationWait: step === 'passive-wait' ? 12_000 : step === 'endpoint-retry' ? 18_000 : 30_000,
                },
                retry: {
                    maxAttempts: step === 'passive-wait' ? 3 : step === 'endpoint-retry' ? 4 : 6,
                    backoffMs: step === 'passive-wait' ? [300, 800, 1300] : step === 'endpoint-retry' ? [400, 900, 1600, 2400] : [800, 1600, 2600, 3800, 5200, 7000],
                    hardTimeoutMs: step === 'passive-wait' ? 12_000 : step === 'endpoint-retry' ? 20_000 : 30_000,
                },
                updatedAt: new Date().toISOString(),
                lastModifiedBy: 'manual',
            });
        } catch (error) {
            logger.warn('Failed to save calibration profile', error);
        }
    }

    function resolveDisplayedCalibrationState(conversationId: string | null): CalibrationUiState {
        if (calibrationState === 'idle' && !!rememberedPreferredStep) {
            return 'success';
        }
        return calibrationState;
    }

    function syncCalibrationButtonDisplay(): void {
        if (!buttonManager.exists() || !currentAdapter) {
            return;
        }
        const conversationId = currentAdapter.extractConversationId(window.location.href);
        const displayState = resolveDisplayedCalibrationState(conversationId);
        buttonManager.setCalibrationState(displayState, {
            timestampLabel:
                displayState === 'success' ? formatCalibrationTimestampLabel(rememberedCalibrationUpdatedAt) : null,
        });
    }

    function formatCalibrationTimestampLabel(updatedAt: string | null): string | null {
        if (!updatedAt) {
            return null;
        }

        const parsed = new Date(updatedAt);
        if (Number.isNaN(parsed.getTime())) {
            return null;
        }

        const now = Date.now();
        const ageMs = Math.max(0, now - parsed.getTime());
        const minuteMs = 60 * 1000;
        const hourMs = 60 * minuteMs;
        const dayMs = 24 * hourMs;

        if (ageMs < minuteMs) {
            return 'just now';
        }

        if (ageMs < hourMs) {
            const mins = Math.floor(ageMs / minuteMs);
            return `${mins}m ago`;
        }

        if (ageMs < dayMs) {
            const hours = Math.floor(ageMs / hourMs);
            return `${hours}h ago`;
        }

        return parsed.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
        });
    }

    function setLifecycleState(state: LifecycleUiState, conversationId?: string): void {
        lifecycleState = state;
        buttonManager.setLifecycleState(state);

        if (!buttonManager.exists()) {
            return;
        }

        if (state === 'completed') {
            const targetConversationId = conversationId || currentConversationId || undefined;
            if (targetConversationId) {
                refreshButtonState(targetConversationId);
                scheduleButtonRefresh(targetConversationId);
            }
            return;
        }

        // While prompt is in-flight/streaming, disable actions to avoid partial exports.
        if (state === 'prompt-sent' || state === 'streaming') {
            buttonManager.setActionButtonsEnabled(false);
            buttonManager.setOpacity('0.6');
        }
    }

    function ensureStreamProbePanel(): HTMLDivElement {
        const existing = document.getElementById('blackiya-stream-probe') as HTMLDivElement | null;
        if (existing) {
            return existing;
        }

        const panel = document.createElement('div');
        panel.id = 'blackiya-stream-probe';
        panel.style.cssText = `
            position: fixed;
            left: 16px;
            bottom: 16px;
            width: min(560px, calc(100vw - 32px));
            max-height: 42vh;
            overflow: auto;
            z-index: 2147483647;
            background: rgba(15, 23, 42, 0.92);
            color: #e2e8f0;
            border: 1px solid rgba(148, 163, 184, 0.45);
            border-radius: 10px;
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
            font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            padding: 10px;
            white-space: pre-wrap;
            word-break: break-word;
        `;
        document.body.appendChild(panel);
        return panel;
    }

    function setStreamProbePanel(status: string, body: string): void {
        const panel = ensureStreamProbePanel();
        const now = new Date().toLocaleTimeString();
        panel.textContent = `[Blackiya Stream Probe] ${status} @ ${now}\n\n${body}`;
    }

    function appendLiveStreamProbeText(conversationId: string, text: string): void {
        const current = liveStreamPreviewByConversation.get(conversationId) ?? '';
        let next = '';
        if (text.startsWith(current)) {
            next = text; // Snapshot-style update (preferred)
        } else if (current.startsWith(text)) {
            next = current; // Stale/shorter snapshot, ignore
        } else {
            next = `${current}${text}`; // Delta-style fallback
        }
        const capped = next.length > 16_000 ? `...${next.slice(-15_500)}` : next;
        liveStreamPreviewByConversation.set(conversationId, capped);
        setStreamProbePanel('stream: live mirror', capped);
    }

    function extractResponseTextForProbe(data: ConversationData): string {
        try {
            const common = buildCommonExport(data, currentAdapter?.name ?? 'Unknown') as {
                response?: string | null;
                prompt?: string | null;
            };
            const response = (common.response ?? '').trim();
            const prompt = (common.prompt ?? '').trim();
            if (response) {
                return response;
            }
            if (prompt) {
                return `(No assistant response found yet)\nPrompt: ${prompt}`;
            }
        } catch {
            // Fall through to raw extraction.
        }

        const messages = Object.values(data.mapping)
            .map((node) => node.message)
            .filter((message): message is NonNullable<(typeof data.mapping)[string]['message']> => !!message);
        const assistantTexts = messages
            .filter((message) => message.author.role === 'assistant')
            .flatMap((message) => message.content.parts ?? [])
            .filter((part) => typeof part === 'string' && part.trim().length > 0);
        return assistantTexts.join('\n\n').trim();
    }

    async function runStreamDoneProbe(conversationId: string): Promise<void> {
        if (!currentAdapter) {
            return;
        }

        const probeKey = `${currentAdapter.name}:${conversationId}:${Date.now()}`;
        lastStreamProbeKey = probeKey;
        setStreamProbePanel('stream-done: fetching conversation', `conversationId=${conversationId}`);
        logger.info('Stream done probe start', {
            platform: currentAdapter.name,
            conversationId,
        });

        const apiUrls = getFetchUrlCandidates(currentAdapter, conversationId);
        if (apiUrls.length === 0) {
            setStreamProbePanel('stream-done: no api url candidates', `conversationId=${conversationId}`);
            logger.warn('Stream done probe has no URL candidates', {
                platform: currentAdapter.name,
                conversationId,
            });
            return;
        }

        for (const apiUrl of apiUrls) {
            try {
                const response = await fetch(apiUrl, { credentials: 'include' });
                if (!response.ok) {
                    continue;
                }
                const text = await response.text();
                const parsed = currentAdapter.parseInterceptedData(text, apiUrl);
                if (!parsed?.conversation_id) {
                    continue;
                }
                if (parsed.conversation_id !== conversationId) {
                    continue;
                }
                const body = extractResponseTextForProbe(parsed);
                const normalizedBody = body.length > 0 ? body : '(empty response text)';
                if (lastStreamProbeKey === probeKey) {
                    setStreamProbePanel('stream-done: fetched full text', normalizedBody);
                }
                logger.info('Stream done probe success', {
                    platform: currentAdapter.name,
                    conversationId,
                    textLength: normalizedBody.length,
                });
                return;
            } catch {
                // try next candidate
            }
        }

        if (lastStreamProbeKey === probeKey) {
            setStreamProbePanel(
                'stream-done: fetch failed',
                `Could not parse conversation payload for ${conversationId}`,
            );
        }
        logger.warn('Stream done probe failed', {
            platform: currentAdapter.name,
            conversationId,
        });
    }

    function buildExportPayloadForFormat(data: ConversationData, format: ExportFormat): unknown {
        if (format !== 'common') {
            return data;
        }

        try {
            return buildCommonExport(data, currentAdapter?.name ?? 'Unknown');
        } catch (error) {
            logger.error('Failed to build common export format, falling back to original.', error);
            return data;
        }
    }

    async function buildExportPayload(data: ConversationData): Promise<unknown> {
        const format = await getExportFormat();
        return buildExportPayloadForFormat(data, format);
    }

    async function handleSaveClick(): Promise<void> {
        if (!currentAdapter) {
            return;
        }
        const data = await getConversationData();
        if (!data) {
            return;
        }
        await saveConversation(data);
    }

    async function handleCopyClick(): Promise<void> {
        if (!currentAdapter) {
            return;
        }
        const data = await getConversationData();
        if (!data) {
            return;
        }

        try {
            const exportPayload = await buildExportPayload(data);
            await navigator.clipboard.writeText(JSON.stringify(exportPayload, null, 2));
            logger.info('Copied conversation to clipboard');
            buttonManager.setSuccess('copy');
        } catch (error) {
            handleError('copy', error);
            buttonManager.setLoading(false, 'copy');
        }
    }

    async function handleCalibrationClick(): Promise<void> {
        if (calibrationState === 'capturing') {
            return;
        }

        if (calibrationState === 'waiting') {
            await runCalibrationCapture('manual');
            return;
        }

        calibrationState = 'waiting';
        buttonManager.setCalibrationState('waiting');
        logger.info('Calibration armed. Click Done when response is complete.');
    }

    function setCalibrationStatus(status: 'idle' | 'waiting' | 'capturing' | 'success' | 'error'): void {
        calibrationState = status;
        buttonManager.setCalibrationState(status, {
            timestampLabel:
                status === 'success' ? formatCalibrationTimestampLabel(rememberedCalibrationUpdatedAt) : null,
        });
    }

    function markCalibrationSuccess(conversationId: string): void {
        setCalibrationStatus('success');
        refreshButtonState(conversationId);
    }

    function markCalibrationError(message: string, data?: unknown): void {
        setCalibrationStatus('error');
        logger.warn(message, data);
    }

    function getFetchUrlCandidates(adapter: LLMPlatform, conversationId: string): string[] {
        const urls: string[] = [];
        const multi = adapter.buildApiUrls?.(conversationId) ?? [];
        for (const url of multi) {
            if (typeof url === 'string' && url.length > 0 && !urls.includes(url)) {
                urls.push(url);
            }
        }

        const primary = adapter.buildApiUrl?.(conversationId);
        if (primary && !urls.includes(primary)) {
            urls.unshift(primary);
        }

        const currentOrigin = window.location.origin;
        const filtered = urls.filter((url) => {
            try {
                return new URL(url, currentOrigin).origin === currentOrigin;
            } catch {
                return false;
            }
        });

        if (filtered.length > 0) {
            return filtered;
        }

        logger.info('Calibration fetch candidates unavailable on current origin', {
            platform: adapter.name,
            conversationId,
            candidateCount: urls.length,
            currentOrigin,
        });

        return [];
    }

    async function tryCalibrationFetch(
        conversationId: string,
        apiUrl: string,
        attempt: number,
        platformName: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        try {
            const response = await fetch(apiUrl, { credentials: 'include' });
            logger.info('Calibration fetch response', {
                attempt,
                conversationId,
                ok: response.ok,
                status: response.status,
            });

            if (!response.ok) {
                return false;
            }

            const text = await response.text();
            interceptionManager.ingestInterceptedData({
                url: apiUrl,
                data: text,
                platform: platformName,
            });

            return isCalibrationCaptureSatisfied(conversationId, mode);
        } catch (error) {
            logger.error('Calibration fetch error', error);
            return false;
        }
    }

    function prepareCalibrationContext(): { adapter: LLMPlatform; conversationId: string } | null {
        if (!currentAdapter) {
            return null;
        }

        const conversationId = currentAdapter.extractConversationId(window.location.href) || currentConversationId;
        if (!conversationId) {
            markCalibrationError('Calibration failed: no conversation ID');
            return null;
        }

        return { adapter: currentAdapter, conversationId };
    }

    async function runCalibrationRetries(
        adapter: LLMPlatform,
        conversationId: string,
        backoff: number[],
        mode: CalibrationMode,
    ): Promise<boolean> {
        const urls = getFetchUrlCandidates(adapter, conversationId);
        if (urls.length === 0) {
            logger.info('Calibration retries skipped: no fetch URL candidates', {
                conversationId,
                platform: adapter.name,
            });
            return false;
        }

        for (let attempt = 0; attempt < backoff.length; attempt++) {
            const waitMs = backoff[attempt];
            if (waitMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }

            for (const apiUrl of urls) {
                const captured = await tryCalibrationFetch(conversationId, apiUrl, attempt + 1, adapter.name, mode);
                if (captured) {
                    return true;
                }
            }
        }
        return false;
    }

    async function requestPageSnapshot(conversationId: string): Promise<unknown | null> {
        const requestId =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;

        return await new Promise((resolve) => {
            const timeout = window.setTimeout(() => {
                window.removeEventListener('message', onMessage);
                resolve(null);
            }, 2500);

            const onMessage = (event: MessageEvent) => {
                if (event.source !== window || event.origin !== window.location.origin) {
                    return;
                }
                const msg = event.data;
                if (msg?.type !== 'BLACKIYA_PAGE_SNAPSHOT_RESPONSE' || msg.requestId !== requestId) {
                    return;
                }
                clearTimeout(timeout);
                window.removeEventListener('message', onMessage);
                resolve(msg.success ? msg.data : null);
            };

            window.addEventListener('message', onMessage);
            window.postMessage(
                {
                    type: 'BLACKIYA_PAGE_SNAPSHOT_REQUEST',
                    requestId,
                    conversationId,
                },
                window.location.origin,
            );
        });
    }

    function hasCapturedConversation(conversationId: string): boolean {
        return !!interceptionManager.getConversation(conversationId);
    }

    function isCalibrationCaptureSatisfied(conversationId: string, mode: CalibrationMode): boolean {
        if (mode === 'auto') {
            return isConversationReadyForActions(conversationId);
        }
        return hasCapturedConversation(conversationId);
    }

    function isRawCaptureSnapshot(
        value: unknown,
    ): value is { __blackiyaSnapshotType: 'raw-capture'; data: string; url: string; platform?: string } {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const candidate = value as Record<string, unknown>;
        return (
            candidate.__blackiyaSnapshotType === 'raw-capture' &&
            typeof candidate.data === 'string' &&
            typeof candidate.url === 'string'
        );
    }

    function isConversationDataLike(value: unknown): value is ConversationData {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const candidate = value as Record<string, unknown>;
        return (
            typeof candidate.conversation_id === 'string' &&
            candidate.conversation_id.length > 0 &&
            !!candidate.mapping &&
            typeof candidate.mapping === 'object'
        );
    }

    function normalizeSnapshotText(text: string): string {
        return text.replace(/\s+/g, ' ').trim();
    }

    function collectSnapshotMessageCandidates(root: ParentNode): SnapshotMessageCandidate[] {
        const selectors: Array<{ selector: string; role: 'user' | 'assistant' }> = [
            { selector: '[data-message-author-role="user"]', role: 'user' },
            { selector: '[data-message-author-role="assistant"]', role: 'assistant' },
            { selector: '[class*="user-query"]', role: 'user' },
            { selector: '[class*="model-response"]', role: 'assistant' },
            { selector: 'user-query', role: 'user' },
            { selector: 'model-response', role: 'assistant' },
        ];

        const collected: SnapshotMessageCandidate[] = [];
        for (const entry of selectors) {
            const nodes = root.querySelectorAll(entry.selector);
            for (const node of nodes) {
                const text = normalizeSnapshotText((node.textContent ?? '').trim());
                if (text.length < 2) {
                    continue;
                }
                collected.push({ role: entry.role, text });
            }
        }

        // Deduplicate while preserving order
        const seen = new Set<string>();
        const deduped: SnapshotMessageCandidate[] = [];
        for (const item of collected) {
            const key = `${item.role}:${item.text}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            deduped.push(item);
        }

        return deduped;
    }

    function collectLooseGrokCandidates(root: ParentNode): SnapshotMessageCandidate[] {
        const nodes = root.querySelectorAll(
            'main article, main [data-testid*="message"], main [class*="message"], main [class*="response"]',
        );

        const rawTexts: string[] = [];
        for (const node of nodes) {
            const text = normalizeSnapshotText((node.textContent ?? '').trim());
            if (text.length < 8) {
                continue;
            }
            rawTexts.push(text);
        }

        const uniqueTexts = Array.from(new Set(rawTexts));
        if (uniqueTexts.length < 2) {
            return [];
        }

        // Fallback role assignment when Grok markup is unlabeled.
        return uniqueTexts.map((text, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            text,
        }));
    }

    function collectLastResortTextCandidates(root: ParentNode): SnapshotMessageCandidate[] {
        const containers = root.querySelectorAll('main, article, section, div');
        const snippets: string[] = [];

        for (const node of containers) {
            const text = normalizeSnapshotText((node.textContent ?? '').trim());
            if (text.length < 40 || text.length > 1200) {
                continue;
            }
            snippets.push(text);
            if (snippets.length >= 6) {
                break;
            }
        }

        const unique = Array.from(new Set(snippets));
        if (unique.length === 0) {
            return [];
        }

        if (unique.length === 1) {
            return [
                { role: 'user', text: 'Captured via calibration fallback' },
                { role: 'assistant', text: unique[0] },
            ];
        }

        return unique.slice(0, 6).map((text, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            text,
        }));
    }

    function buildConversationDataFromMessages(
        conversationId: string,
        platformName: string,
        messages: SnapshotMessageCandidate[],
    ): ConversationData | null {
        if (messages.length === 0) {
            return null;
        }

        const mapping: ConversationData['mapping'] = {};
        const now = Date.now() / 1000;

        for (let index = 0; index < messages.length; index++) {
            const msg = messages[index];
            const id = `snapshot-${index + 1}`;
            mapping[id] = {
                id,
                message: {
                    id,
                    author: {
                        role: msg.role,
                        name: msg.role === 'user' ? 'User' : platformName,
                        metadata: {},
                    },
                    create_time: now + index,
                    update_time: now + index,
                    content: {
                        content_type: 'text',
                        parts: [msg.text],
                    },
                    status: 'finished_successfully',
                    end_turn: true,
                    weight: 1,
                    metadata: {},
                    recipient: 'all',
                    channel: null,
                },
                parent: index === 0 ? null : `snapshot-${index}`,
                children: index === messages.length - 1 ? [] : [`snapshot-${index + 2}`],
            };
        }

        return {
            title: document.title || `${platformName} Conversation`,
            create_time: now,
            update_time: now + messages.length,
            conversation_id: conversationId,
            mapping,
            current_node: `snapshot-${messages.length}`,
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'snapshot',
            safe_urls: [],
            blocked_urls: [],
        };
    }

    function buildIsolatedDomSnapshot(adapter: LLMPlatform, conversationId: string): ConversationData | null {
        const roots: ParentNode[] = [];
        const main = document.querySelector('main');
        if (main) {
            roots.push(main);
        }
        roots.push(document.body);

        for (const root of roots) {
            const candidates = collectSnapshotMessageCandidates(root);
            if (candidates.length >= 2) {
                logger.info('Calibration isolated DOM snapshot candidates found', {
                    conversationId,
                    platform: adapter.name,
                    count: candidates.length,
                });
                return buildConversationDataFromMessages(conversationId, adapter.name, candidates);
            }

            if (adapter.name === 'Grok') {
                const looseCandidates = collectLooseGrokCandidates(root);
                if (looseCandidates.length >= 2) {
                    logger.info('Calibration isolated DOM Grok fallback candidates found', {
                        conversationId,
                        platform: adapter.name,
                        count: looseCandidates.length,
                    });
                    return buildConversationDataFromMessages(conversationId, adapter.name, looseCandidates);
                }

                const lastResortCandidates = collectLastResortTextCandidates(root);
                if (lastResortCandidates.length >= 2) {
                    logger.info('Calibration isolated DOM Grok last-resort candidates found', {
                        conversationId,
                        platform: adapter.name,
                        count: lastResortCandidates.length,
                    });
                    return buildConversationDataFromMessages(conversationId, adapter.name, lastResortCandidates);
                }
            }
        }

        return null;
    }

    function getRawSnapshotReplayUrls(
        adapter: LLMPlatform,
        conversationId: string,
        rawSnapshot: { url: string },
    ): string[] {
        const urls = [rawSnapshot.url];

        if (adapter.name !== 'Grok') {
            return urls;
        }

        const grokCandidates = [
            `https://grok.com/rest/app-chat/conversations/${conversationId}/load-responses`,
            `https://grok.com/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`,
            `https://grok.com/rest/app-chat/conversations_v2/${conversationId}?includeWorkspaces=true&includeTaskResult=true`,
        ];

        for (const candidate of grokCandidates) {
            if (!urls.includes(candidate)) {
                urls.push(candidate);
            }
        }

        return urls;
    }

    function getCalibrationPassiveWaitMs(adapter: LLMPlatform): number {
        if (adapter.name === 'ChatGPT') {
            return 1200;
        }
        if (adapter.name === 'Gemini' || adapter.name === 'Grok') {
            return 3500;
        }
        return 2000;
    }

    async function waitForPassiveCapture(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        const timeoutMs = getCalibrationPassiveWaitMs(adapter);
        const intervalMs = 250;

        logger.info('Calibration passive wait start', {
            conversationId,
            platform: adapter.name,
            timeoutMs,
        });

        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            interceptionManager.flushQueuedMessages();
            if (isCalibrationCaptureSatisfied(conversationId, mode)) {
                logger.info('Calibration passive wait captured', {
                    conversationId,
                    platform: adapter.name,
                    elapsedMs: Date.now() - started,
                });
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }

        logger.info('Calibration passive wait timeout', {
            conversationId,
            platform: adapter.name,
        });
        return false;
    }

    async function waitForDomQuietPeriod(
        adapter: LLMPlatform,
        conversationId: string,
        quietMs: number,
        maxWaitMs: number,
    ): Promise<boolean> {
        const root = document.querySelector('main') ?? document.body;
        if (!root) {
            return true;
        }

        logger.info('Calibration snapshot quiet-wait start', {
            conversationId,
            platform: adapter.name,
            quietMs,
            maxWaitMs,
        });

        return await new Promise((resolve) => {
            const startedAt = Date.now();
            let lastMutationAt = Date.now();
            let done = false;

            const finalize = (settled: boolean) => {
                if (done) {
                    return;
                }
                done = true;
                observer.disconnect();
                clearInterval(intervalId);
                logger.info('Calibration snapshot quiet-wait result', {
                    conversationId,
                    platform: adapter.name,
                    settled,
                    elapsedMs: Date.now() - startedAt,
                });
                resolve(settled);
            };

            const observer = new MutationObserver(() => {
                lastMutationAt = Date.now();
            });

            observer.observe(root, {
                childList: true,
                subtree: true,
                characterData: true,
            });

            const intervalId = window.setInterval(() => {
                const now = Date.now();
                if (now - lastMutationAt >= quietMs) {
                    finalize(true);
                    return;
                }
                if (now - startedAt >= maxWaitMs) {
                    finalize(false);
                }
            }, 250);
        });
    }

    async function captureFromSnapshot(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        if (mode === 'auto' && (adapter.name === 'Gemini' || adapter.name === 'ChatGPT')) {
            const quietSettled = await waitForDomQuietPeriod(adapter, conversationId, 1400, 20000);
            if (!quietSettled) {
                logger.info('Calibration snapshot deferred; DOM still active', {
                    conversationId,
                    platform: adapter.name,
                    mode,
                });
                return false;
            }
        }

        logger.info('Calibration snapshot fallback requested', { conversationId });
        const snapshot = await requestPageSnapshot(conversationId);
        let isolatedSnapshot = snapshot ? null : buildIsolatedDomSnapshot(adapter, conversationId);
        logger.info('Calibration snapshot fallback response', {
            conversationId,
            hasSnapshot: !!snapshot || !!isolatedSnapshot,
            source: snapshot ? 'main-world' : isolatedSnapshot ? 'isolated-dom' : 'none',
        });

        const effectiveSnapshot = snapshot ?? isolatedSnapshot;
        if (!effectiveSnapshot) {
            return false;
        }

        try {
            if (isConversationDataLike(effectiveSnapshot)) {
                interceptionManager.ingestConversationData(effectiveSnapshot, 'calibration-snapshot');
            } else if (isRawCaptureSnapshot(effectiveSnapshot)) {
                const replayUrls = getRawSnapshotReplayUrls(adapter, conversationId, effectiveSnapshot);
                logger.info('Calibration using raw capture snapshot', {
                    conversationId,
                    platform: adapter.name,
                    replayCandidates: replayUrls.length,
                });

                for (const replayUrl of replayUrls) {
                    logger.info('Calibration raw snapshot replay attempt', {
                        conversationId,
                        platform: adapter.name,
                        replayUrl,
                    });

                    interceptionManager.ingestInterceptedData({
                        url: replayUrl,
                        data: effectiveSnapshot.data,
                        platform: effectiveSnapshot.platform ?? adapter.name,
                    });

                    if (isCalibrationCaptureSatisfied(conversationId, mode)) {
                        logger.info('Calibration raw snapshot replay captured', {
                            conversationId,
                            platform: adapter.name,
                            replayUrl,
                        });
                        break;
                    }
                }
            } else {
                interceptionManager.ingestInterceptedData({
                    url: `page-snapshot://${adapter.name}/${conversationId}`,
                    data: JSON.stringify(effectiveSnapshot),
                    platform: adapter.name,
                });
            }
        } catch {
            // Ignore ingestion errors; handled by cache check below.
        }

        if (!isCalibrationCaptureSatisfied(conversationId, mode) && isRawCaptureSnapshot(effectiveSnapshot)) {
            logger.info('Calibration snapshot replay did not capture conversation', {
                conversationId,
                platform: adapter.name,
                replayUrl: effectiveSnapshot.url,
            });

            if (!isolatedSnapshot) {
                isolatedSnapshot = buildIsolatedDomSnapshot(adapter, conversationId);
            }

            if (isolatedSnapshot) {
                logger.info('Calibration isolated DOM fallback after replay failure', {
                    conversationId,
                    platform: adapter.name,
                });
                interceptionManager.ingestConversationData(isolatedSnapshot, 'calibration-isolated-dom-fallback');
            }
        }

        return isCalibrationCaptureSatisfied(conversationId, mode);
    }

    async function captureFromRetries(
        adapter: LLMPlatform,
        conversationId: string,
        mode: CalibrationMode,
    ): Promise<boolean> {
        const backoff = [0, 1500, 3000, 5000, 8000, 12000];
        return await runCalibrationRetries(adapter, conversationId, backoff, mode);
    }

    async function runCalibrationCapture(
        mode: CalibrationMode = 'manual',
        hintedConversationId?: string,
    ): Promise<void> {
        if (calibrationState === 'capturing') {
            return;
        }
        const context = prepareCalibrationContext();
        if (!context) {
            return;
        }
        const { adapter } = context;
        const conversationId = hintedConversationId || context.conversationId;

        if (mode === 'manual') {
            setCalibrationStatus('capturing');
        } else {
            calibrationState = 'capturing';
        }
        logger.info('Calibration capture started', { conversationId, platform: adapter.name });
        const strategyOrder = buildCalibrationOrderForMode(rememberedPreferredStep, mode, adapter.name);
        logger.info('Calibration strategy', {
            platform: adapter.name,
            steps: strategyOrder,
            mode,
            remembered: rememberedPreferredStep,
        });

        for (const step of strategyOrder) {
            let captured = false;
            if (step === 'queue-flush') {
                interceptionManager.flushQueuedMessages();
                captured = isCalibrationCaptureSatisfied(conversationId, mode);
            } else if (step === 'passive-wait') {
                captured = await waitForPassiveCapture(adapter, conversationId, mode);
            } else if (step === 'endpoint-retry') {
                captured = await captureFromRetries(adapter, conversationId, mode);
            } else if (step === 'page-snapshot') {
                captured = await captureFromSnapshot(adapter, conversationId, mode);
            }

            if (!captured) {
                continue;
            }

            if (mode === 'manual') {
                markCalibrationSuccess(conversationId);
            } else {
                calibrationState = 'success';
                refreshButtonState(conversationId);
            }

            if (shouldPersistCalibrationProfile(mode)) {
                await rememberCalibrationSuccess(adapter.name, step);
            }
            logger.info('Calibration capture succeeded', { conversationId, step, mode });
            return;
        }

        if (mode === 'manual') {
            setCalibrationStatus('error');
            refreshButtonState(conversationId);
        } else {
            calibrationState = 'idle';
        }
        logger.warn('Calibration capture failed after retries', { conversationId });
    }

    async function getConversationData(options: { silent?: boolean } = {}) {
        if (!currentAdapter) {
            return null;
        }

        const conversationId = currentAdapter.extractConversationId(window.location.href) || currentConversationId;
        if (!conversationId) {
            logger.error('No conversation ID found in URL');
            if (!options.silent) {
                alert('Please select a conversation first.');
            }
            return null;
        }

        const data = interceptionManager.getConversation(conversationId);
        if (!data) {
            logger.warn('No data captured for this conversation yet.');
            if (!options.silent) {
                alert(
                    'Conversation data not yet captured. Please refresh the page or wait for the conversation to load.',
                );
            }
            return null;
        }

        const shouldBlockForGeneration = currentAdapter.name === 'ChatGPT';
        if (!isConversationReady(data) || (shouldBlockForGeneration && isPlatformGenerating(currentAdapter))) {
            logger.warn('Conversation is still generating; export blocked until completion.', {
                conversationId,
                platform: currentAdapter.name,
            });
            if (!options.silent) {
                alert('Response is still generating. Please wait for completion, then try again.');
            }
            return null;
        }
        return data;
    }

    function handleError(action: 'save' | 'copy', error: unknown, silent?: boolean) {
        logger.error(`Failed to ${action} conversation:`, error);
        if (!silent) {
            alert(`Failed to ${action} conversation. Check console for details.`);
        }
    }

    async function saveConversation(data: ConversationData): Promise<boolean> {
        if (!currentAdapter) {
            return false;
        }

        if (buttonManager.exists()) {
            buttonManager.setLoading(true, 'save');
        }

        try {
            const filename = currentAdapter.formatFilename(data);
            const exportPayload = await buildExportPayload(data);
            downloadAsJSON(exportPayload, filename);
            logger.info(`Saved conversation: ${filename}.json`);
            if (buttonManager.exists()) {
                buttonManager.setSuccess('save');
            }
            return true;
        } catch (error) {
            handleError('save', error);
            if (buttonManager.exists()) {
                buttonManager.setLoading(false, 'save');
            }
            return false;
        }
    }

    function injectSaveButton(): void {
        const conversationId = currentAdapter?.extractConversationId(window.location.href) || null;
        const target = currentAdapter?.getButtonInjectionTarget();
        if (!target) {
            logger.info('Button target missing; retry pending', {
                platform: currentAdapter?.name ?? 'unknown',
                conversationId,
            });
            return;
        }

        buttonManager.inject(target, conversationId);
        buttonManager.setLifecycleState(lifecycleState);
        const displayState = resolveDisplayedCalibrationState(conversationId);
        buttonManager.setCalibrationState(displayState, {
            timestampLabel:
                displayState === 'success' ? formatCalibrationTimestampLabel(rememberedCalibrationUpdatedAt) : null,
        });

        if (!conversationId) {
            logger.info('No conversation ID yet; showing calibration only');
            const hasFallbackData =
                !!currentConversationId && !!interceptionManager.getConversation(currentConversationId);
            buttonManager.setActionButtonsEnabled(hasFallbackData);
            buttonManager.setOpacity(hasFallbackData ? '1' : '0.6');
            return;
        }

        buttonManager.setActionButtonsEnabled(true);
        currentConversationId = conversationId;

        refreshButtonState(conversationId);
        scheduleButtonRefresh(conversationId);
    }

    function handleNavigationChange(): void {
        if (!currentAdapter) {
            return;
        }

        const newConversationId = currentAdapter.extractConversationId(window.location.href);

        if (newConversationId !== currentConversationId) {
            handleConversationSwitch(newConversationId);
        } else {
            // ID hasn't changed, but maybe DOM has (re-render), ensure button exists
            if (newConversationId && !buttonManager.exists()) {
                setTimeout(injectSaveButton, 500);
            } else {
                refreshButtonState(newConversationId || undefined);
            }
        }
    }

    function disposeInFlightAttemptsOnNavigation(): void {
        const disposedAttemptIds = sfe.getAttemptTracker().disposeAllForRouteChange();
        for (const attemptId of disposedAttemptIds) {
            emitAttemptDisposed(attemptId, 'navigation');
            structuredLogger.emit(
                attemptId,
                'info',
                'attempt_disposed',
                'Attempt disposed on navigation',
                { reason: 'navigation' },
                `dispose:navigation:${attemptId}`,
            );
        }
    }

    function handleConversationSwitch(newId: string | null): void {
        disposeInFlightAttemptsOnNavigation();
        if (!newId) {
            currentConversationId = null;
            setLifecycleState('idle');
            setTimeout(injectSaveButton, 300);
            return;
        }

        buttonManager.remove();
        currentConversationId = newId;

        // Determine if we need to update adapter (e.g. cross-platform nav? likely not in same tab but good practice)
        const newAdapter = getPlatformAdapter(window.location.href);
        if (newAdapter && currentAdapter && newAdapter.name !== currentAdapter.name) {
            currentAdapter = newAdapter;
            updateManagers();
            calibrationPreferenceLoaded = false;
            calibrationPreferenceLoading = null;
            void ensureCalibrationPreferenceLoaded(currentAdapter.name);
        }

        setTimeout(injectSaveButton, 500);
        setLifecycleState('idle', newId);
        setTimeout(() => {
            if (newId) {
                maybeRunAutoCapture(newId, 'navigation');
            }
        }, 1800);
    }

    function updateManagers(): void {
        interceptionManager.updateAdapter(currentAdapter);
    }

    function refreshButtonState(forConversationId?: string): void {
        if (!buttonManager.exists() || !currentAdapter) {
            return;
        }
        const conversationId = forConversationId || currentAdapter.extractConversationId(window.location.href);
        if (!conversationId) {
            return;
        }
        const cached = interceptionManager.getConversation(conversationId);
        if (cached) {
            ingestSfeCanonicalSample(cached, attemptByConversation.get(conversationId));
        }
        buttonManager.setReadinessSource(SFE_ENABLED ? 'sfe' : 'legacy');
        const hasData = isConversationReadyForActions(conversationId);
        const opacity = hasData ? '1' : '0.6';
        buttonManager.setActionButtonsEnabled(hasData);
        buttonManager.setOpacity(opacity);
        logButtonStateIfChanged(conversationId, hasData, opacity);
        if (hasData && calibrationState !== 'capturing') {
            calibrationState = 'success';
            syncCalibrationButtonDisplay();
        } else if (!hasData && calibrationState === 'success') {
            calibrationState = 'idle';
            syncCalibrationButtonDisplay();
        }
    }

    function scheduleButtonRefresh(conversationId: string): void {
        let attempts = 0;
        const maxAttempts = 6;
        const intervalMs = 500;

        const tick = () => {
            attempts += 1;
            if (!buttonManager.exists()) {
                return;
            }
            const hasData = isConversationReadyForActions(conversationId);
            if (hasData) {
                buttonManager.setActionButtonsEnabled(true);
                buttonManager.setOpacity('1');
                logButtonStateIfChanged(conversationId, true, '1');
                return;
            }
            buttonManager.setActionButtonsEnabled(false);
            if (attempts < maxAttempts) {
                setTimeout(tick, intervalMs);
            } else {
                logButtonStateIfChanged(conversationId, false, '0.6');
            }
        };

        setTimeout(tick, intervalMs);
    }

    function isChatGPTGenerating(): boolean {
        const stopSelectors = [
            '[data-testid="stop-button"]',
            'button[aria-label*="Stop generating"]',
            'button[aria-label*="Stop response"]',
            'button[aria-label="Stop"]',
        ];

        for (const selector of stopSelectors) {
            const button = document.querySelector(selector) as HTMLButtonElement | null;
            if (button && !button.disabled) {
                return true;
            }
        }

        return !!document.querySelector('[data-is-streaming="true"], [data-testid*="streaming"]');
    }

    function hasEnabledStopControl(selectors: string[]): boolean {
        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                if (!(element instanceof HTMLButtonElement)) {
                    continue;
                }
                if (!element.disabled) {
                    return true;
                }
            }
        }
        return false;
    }

    function isGeminiGenerating(): boolean {
        const stopSelectors = [
            'button[aria-label*="Stop"]',
            'button[aria-label*="stop"]',
            'button[title*="Stop"]',
            'button[title*="stop"]',
            'button[data-test-id*="stop"]',
            'button[data-testid*="stop"]',
        ];

        if (hasEnabledStopControl(stopSelectors)) {
            return true;
        }

        return !!document.querySelector(
            '[data-test-id*="thinking"], [data-testid*="thinking"], [class*="generating"], [class*="streaming"]',
        );
    }

    function isGrokGenerating(): boolean {
        const stopSelectors = [
            'button[aria-label*="Stop"]',
            'button[aria-label*="stop"]',
            'button[data-testid*="stop"]',
        ];

        if (hasEnabledStopControl(stopSelectors)) {
            return true;
        }

        return !!document.querySelector('[data-testid*="typing"], [class*="generating"], [class*="streaming"]');
    }

    function isPlatformGenerating(adapter: LLMPlatform | null): boolean {
        if (!adapter) {
            return false;
        }
        if (adapter.name === 'ChatGPT') {
            return isChatGPTGenerating();
        }
        if (adapter.name === 'Gemini') {
            return isGeminiGenerating();
        }
        if (adapter.name === 'Grok') {
            return isGrokGenerating();
        }
        return false;
    }

    function isConversationReadyForActions(conversationId: string): boolean {
        const data = interceptionManager.getConversation(conversationId);
        let legacyReady = false;
        if (data && isConversationReady(data)) {
            legacyReady = !(currentAdapter?.name === 'ChatGPT' && isPlatformGenerating(currentAdapter));
        }

        logSfeMismatchIfNeeded(conversationId, legacyReady);

        if (!SFE_ENABLED) {
            return legacyReady;
        }
        return resolveSfeReady(conversationId);
    }

    function resolveActiveConversationId(hintedConversationId?: string): string | null {
        if (hintedConversationId) {
            return hintedConversationId;
        }
        if (!currentAdapter) {
            return currentConversationId;
        }
        return currentAdapter.extractConversationId(window.location.href) || currentConversationId;
    }

    function shouldProcessFinishedSignal(conversationId: string | null): boolean {
        const now = Date.now();
        const isSameConversation = conversationId === lastResponseFinishedConversationId;
        if (isSameConversation && now - lastResponseFinishedAt < 1500) {
            return false;
        }
        lastResponseFinishedAt = now;
        lastResponseFinishedConversationId = conversationId;
        return true;
    }

    function maybeRunAutoCapture(conversationId: string, reason: 'response-finished' | 'navigation'): void {
        if (!currentAdapter || calibrationState !== 'idle' || isConversationReadyForActions(conversationId)) {
            return;
        }

        const attemptKey = `${currentAdapter.name}:${conversationId}`;
        const shouldDeferWhileGenerating = currentAdapter.name === 'ChatGPT';
        if (shouldDeferWhileGenerating && isPlatformGenerating(currentAdapter)) {
            if (!autoCaptureRetryTimers.has(attemptKey)) {
                if (!autoCaptureDeferredLogged.has(attemptKey)) {
                    logger.info('Auto calibration deferred: response still generating', {
                        platform: currentAdapter.name,
                        conversationId,
                        reason,
                    });
                    autoCaptureDeferredLogged.add(attemptKey);
                }
                const timerId = window.setTimeout(() => {
                    autoCaptureRetryTimers.delete(attemptKey);
                    maybeRunAutoCapture(conversationId, reason);
                }, 4000);
                autoCaptureRetryTimers.set(attemptKey, timerId);
            }
            return;
        }
        autoCaptureDeferredLogged.delete(attemptKey);

        const now = Date.now();
        const lastAttempt = autoCaptureAttempts.get(attemptKey) ?? 0;
        if (now - lastAttempt < 12000) {
            return;
        }
        autoCaptureAttempts.set(attemptKey, now);

        const run = () => {
            if (!currentAdapter || calibrationState !== 'idle' || isConversationReadyForActions(conversationId)) {
                return;
            }
            if (!rememberedPreferredStep) {
                return;
            }
            logger.info('Auto calibration run from remembered strategy', {
                platform: currentAdapter.name,
                conversationId,
                preferredStep: rememberedPreferredStep,
                reason,
            });
            void runCalibrationCapture('auto', conversationId);
        };

        if (rememberedPreferredStep || calibrationPreferenceLoaded) {
            run();
        } else {
            void ensureCalibrationPreferenceLoaded(currentAdapter.name).then(run);
        }
    }

    function handleResponseFinished(source: 'network' | 'dom', hintedConversationId?: string): void {
        const conversationId = resolveActiveConversationId(hintedConversationId);
        if (!shouldProcessFinishedSignal(conversationId)) {
            return;
        }
        const attemptId = resolveAttemptId(conversationId ?? undefined);
        activeAttemptId = attemptId;
        ingestSfeLifecycle('completed_hint', attemptId, conversationId);

        if (conversationId) {
            currentConversationId = conversationId;
            bindAttempt(conversationId, attemptId);
        }

        logger.info('Response finished signal', {
            source,
            attemptId,
            conversationId,
            calibrationState,
        });

        if (calibrationState === 'waiting') {
            return;
        }

        if (conversationId) {
            refreshButtonState(conversationId);
            scheduleButtonRefresh(conversationId);
            maybeRunAutoCapture(conversationId, 'response-finished');
        }
    }

    function registerCompletionWatcher(): () => void {
        if (currentAdapter?.name !== 'ChatGPT') {
            return () => {};
        }

        let wasGenerating = isChatGPTGenerating();

        const checkGenerationTransition = () => {
            const generating = isChatGPTGenerating();
            if (wasGenerating && !generating) {
                handleResponseFinished('dom');
            }
            wasGenerating = generating;
        };

        const observer = new MutationObserver(() => {
            checkGenerationTransition();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-testid', 'aria-label', 'data-is-streaming'],
        });

        const intervalId = window.setInterval(checkGenerationTransition, 800);

        return () => {
            observer.disconnect();
            clearInterval(intervalId);
        };
    }

    function isSameWindowOrigin(event: MessageEvent): boolean {
        return event.source === window && event.origin === window.location.origin;
    }

    function handleResponseFinishedMessage(message: any): boolean {
        if (
            !isLegacyFinishedMessage(message) &&
            !(
                (message as ResponseFinishedMessage | undefined)?.type === 'BLACKIYA_RESPONSE_FINISHED' &&
                typeof (message as ResponseFinishedMessage).attemptId === 'string'
            )
        ) {
            return false;
        }
        const typed = message as ResponseFinishedMessage;
        const hintedConversationId = typeof message.conversationId === 'string' ? message.conversationId : undefined;
        const attemptId =
            typeof typed.attemptId === 'string'
                ? typed.attemptId
                : buildLegacyAttemptId(typed.platform ?? currentAdapter?.name ?? 'Unknown', hintedConversationId);
        activeAttemptId = attemptId;
        if (hintedConversationId) {
            bindAttempt(hintedConversationId, attemptId);
        }
        handleResponseFinished('network', hintedConversationId);
        return true;
    }

    function handleLifecycleMessage(message: any): boolean {
        if (
            !isLegacyLifecycleMessage(message) &&
            !(
                (message as ResponseLifecycleMessage | undefined)?.type === 'BLACKIYA_RESPONSE_LIFECYCLE' &&
                typeof (message as ResponseLifecycleMessage).attemptId === 'string'
            )
        ) {
            return false;
        }

        const typed = message as ResponseLifecycleMessage;
        const phase = typed.phase;
        const platform = typed.platform;
        const conversationId = typeof typed.conversationId === 'string' ? typed.conversationId : undefined;
        const attemptId =
            typeof typed.attemptId === 'string'
                ? typed.attemptId
                : buildLegacyAttemptId(platform ?? currentAdapter?.name ?? 'Unknown', conversationId);

        if (conversationId) {
            currentConversationId = conversationId;
            bindAttempt(conversationId, attemptId);
        }
        activeAttemptId = attemptId;

        if (phase !== 'prompt-sent' && phase !== 'streaming' && phase !== 'completed' && phase !== 'terminated') {
            return true;
        }

        logger.info('Lifecycle phase', {
            platform,
            phase,
            attemptId,
            conversationId: conversationId ?? null,
        });

        if (phase === 'prompt-sent') {
            ingestSfeLifecycle('prompt_sent', attemptId, conversationId ?? null);
        } else if (phase === 'streaming') {
            ingestSfeLifecycle('streaming', attemptId, conversationId ?? null);
        } else if (phase === 'completed') {
            ingestSfeLifecycle('completed_hint', attemptId, conversationId ?? null);
        } else if (phase === 'terminated') {
            ingestSfeLifecycle('terminated_partial', attemptId, conversationId ?? null);
        }

        if ((phase === 'prompt-sent' || phase === 'streaming') && conversationId) {
            if (!liveStreamPreviewByConversation.has(conversationId)) {
                liveStreamPreviewByConversation.set(conversationId, '');
                setStreamProbePanel('stream: awaiting delta', `conversationId=${conversationId}`);
            }
        }

        if (phase === 'completed') {
            setLifecycleState('completed', conversationId);
            if (conversationId) {
                void runStreamDoneProbe(conversationId);
            }
        } else if (phase === 'prompt-sent' || phase === 'streaming') {
            setLifecycleState(phase, conversationId);
        }

        return true;
    }

    function handleStreamDeltaMessage(message: any): boolean {
        if (
            !isLegacyStreamDeltaMessage(message) &&
            !(
                (message as StreamDeltaMessage | undefined)?.type === 'BLACKIYA_STREAM_DELTA' &&
                typeof (message as StreamDeltaMessage).attemptId === 'string'
            )
        ) {
            return false;
        }
        if ((message as StreamDeltaMessage).platform !== 'ChatGPT') {
            return false;
        }

        const text = typeof message.text === 'string' ? message.text : '';
        if (text.length === 0) {
            return true;
        }

        const conversationId =
            typeof message.conversationId === 'string' && message.conversationId.length > 0
                ? message.conversationId
                : currentConversationId;

        if (!conversationId) {
            return true;
        }

        const typed = message as StreamDeltaMessage;
        const attemptId =
            typeof typed.attemptId === 'string'
                ? typed.attemptId
                : buildLegacyAttemptId(typed.platform ?? currentAdapter?.name ?? 'Unknown', conversationId);
        activeAttemptId = attemptId;
        bindAttempt(conversationId, attemptId);
        appendLiveStreamProbeText(conversationId, text);
        return true;
    }

    function handleConversationIdResolvedMessage(message: any): boolean {
        if ((message as ConversationIdResolvedMessage | undefined)?.type !== 'BLACKIYA_CONVERSATION_ID_RESOLVED') {
            return false;
        }

        const typed = message as ConversationIdResolvedMessage;
        if (typeof typed.attemptId !== 'string' || typeof typed.conversationId !== 'string') {
            return false;
        }

        activeAttemptId = typed.attemptId;
        bindAttempt(typed.conversationId, typed.attemptId);
        sfe.getAttemptTracker().updateConversationId(typed.attemptId, typed.conversationId);
        return true;
    }

    function handleAttemptDisposedMessage(message: any): boolean {
        if ((message as AttemptDisposedMessage | undefined)?.type !== 'BLACKIYA_ATTEMPT_DISPOSED') {
            return false;
        }
        const typed = message as AttemptDisposedMessage;
        if (typeof typed.attemptId !== 'string') {
            return false;
        }
        sfe.dispose(typed.attemptId);
        for (const [conversationId, attemptId] of attemptByConversation.entries()) {
            if (attemptId === typed.attemptId) {
                attemptByConversation.delete(conversationId);
            }
        }
        if (activeAttemptId === typed.attemptId) {
            activeAttemptId = null;
        }
        return true;
    }

    function postWindowBridgeResponse(
        requestId: string,
        success: boolean,
        options?: { data?: unknown; error?: string },
    ): void {
        window.postMessage(
            {
                type: 'BLACKIYA_GET_JSON_RESPONSE',
                requestId,
                success,
                data: options?.data,
                error: options?.error,
            },
            window.location.origin,
        );
    }

    function handleJsonBridgeRequest(message: any): void {
        if (message?.type !== 'BLACKIYA_GET_JSON_REQUEST') {
            return;
        }

        if (typeof message.requestId !== 'string') {
            return;
        }

        const requestId = message.requestId;
        const requestFormat = message.format === 'common' ? 'common' : 'original';
        getConversationData({ silent: true })
            .then((data) => {
                if (!data) {
                    postWindowBridgeResponse(requestId, false, { error: 'NO_CONVERSATION_DATA' });
                    return;
                }
                const payload = buildExportPayloadForFormat(data, requestFormat);
                postWindowBridgeResponse(requestId, true, { data: payload });
            })
            .catch((error) => {
                logger.error('Failed to handle window get request:', error);
                postWindowBridgeResponse(requestId, false, { error: 'INTERNAL_ERROR' });
            });
    }

    function registerWindowBridge(): () => void {
        const handler = (event: MessageEvent) => {
            if (!isSameWindowOrigin(event)) {
                return;
            }

            const message = event.data;
            if (handleAttemptDisposedMessage(message)) {
                return;
            }
            if (handleConversationIdResolvedMessage(message)) {
                return;
            }
            if (handleStreamDeltaMessage(message)) {
                return;
            }
            if (handleLifecycleMessage(message)) {
                return;
            }
            if (handleResponseFinishedMessage(message)) {
                return;
            }
            handleJsonBridgeRequest(message);
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }

    function registerButtonHealthCheck(): () => void {
        const intervalId = window.setInterval(() => {
            if (!currentAdapter) {
                return;
            }

            const activeConversationId =
                currentAdapter.extractConversationId(window.location.href) || currentConversationId;
            if (!activeConversationId) {
                return;
            }

            if (!buttonManager.exists()) {
                injectSaveButton();
                return;
            }

            refreshButtonState(activeConversationId);
        }, 1800);

        return () => clearInterval(intervalId);
    }

    function logButtonStateIfChanged(conversationId: string, hasData: boolean, opacity: string): void {
        const key = `${conversationId}:${hasData ? 'ready' : 'waiting'}:${opacity}`;
        if (lastButtonStateLog === key) {
            return;
        }
        lastButtonStateLog = key;
        logger.info('Button state', {
            conversationId,
            hasData,
            opacity,
        });
    }

    // -- Boot Sequence --

    const url = window.location.href;
    currentAdapter = getPlatformAdapter(url);

    if (!currentAdapter) {
        logger.warn('No matching platform adapter for this URL');
        return;
    }

    logger.info(`Content script running for ${currentAdapter.name}`);
    logger.info('Runner init', {
        platform: currentAdapter.name,
        url: window.location.href,
    });

    // Update managers with initial adapter
    updateManagers();
    void ensureCalibrationPreferenceLoaded(currentAdapter.name);

    const storageChangeListener: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, areaName) => {
        if (areaName !== 'local') {
            return;
        }
        if (!changes[STORAGE_KEYS.CALIBRATION_PROFILES] || !currentAdapter) {
            return;
        }

        calibrationPreferenceLoaded = false;
        calibrationPreferenceLoading = null;
        autoCaptureAttempts.clear();
        autoCaptureDeferredLogged.clear();
        for (const timerId of autoCaptureRetryTimers.values()) {
            clearTimeout(timerId);
        }
        autoCaptureRetryTimers.clear();
        void ensureCalibrationPreferenceLoaded(currentAdapter.name);
    };
    browser.storage.onChanged.addListener(storageChangeListener);

    // Start listening
    interceptionManager.start();
    navigationManager.start();
    cleanupWindowBridge = registerWindowBridge();
    cleanupCompletionWatcher = registerCompletionWatcher();
    cleanupButtonHealthCheck = registerButtonHealthCheck();

    // Initial injection
    currentConversationId = currentAdapter.extractConversationId(url);
    injectSaveButton();

    // Retry logic for initial load (sometimes SPA takes time to render header)
    const retryIntervals = [1000, 2000, 5000];
    for (const delay of retryIntervals) {
        setTimeout(() => {
            if (!buttonManager.exists()) {
                injectSaveButton();
            }
        }, delay);
    }

    // Cleanup on unload
    window.addEventListener('beforeunload', () => {
        try {
            const disposed = sfe.disposeAll();
            for (const attemptId of disposed) {
                emitAttemptDisposed(attemptId, 'teardown');
            }
            interceptionManager.stop();
            navigationManager.stop();
            buttonManager.remove();
            cleanupWindowBridge?.();
            cleanupCompletionWatcher?.();
            cleanupButtonHealthCheck?.();
            browser.storage.onChanged.removeListener(storageChangeListener);
            for (const timerId of autoCaptureRetryTimers.values()) {
                clearTimeout(timerId);
            }
            autoCaptureRetryTimers.clear();
            autoCaptureDeferredLogged.clear();
        } catch (error) {
            logger.debug('Error during cleanup:', error);
        }
    });
}
