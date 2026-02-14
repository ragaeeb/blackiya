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
import { buildCommonExport } from '@/utils/common-export';
import { downloadAsJSON } from '@/utils/download';
import { logger } from '@/utils/logger';
import { InterceptionManager } from '@/utils/managers/interception-manager';
import { NavigationManager } from '@/utils/managers/navigation-manager';
import { DEFAULT_EXPORT_FORMAT, type ExportFormat, STORAGE_KEYS } from '@/utils/settings';
import type { ConversationData } from '@/utils/types';
import { ButtonManager } from '@/utils/ui/button-manager';

interface SnapshotMessageCandidate {
    role: 'user' | 'assistant';
    text: string;
}

export function runPlatform(): void {
    let currentAdapter: LLMPlatform | null = null;
    let currentConversationId: string | null = null;
    let cleanupWindowBridge: (() => void) | null = null;
    let cleanupCompletionWatcher: (() => void) | null = null;
    let lastButtonStateLog = '';
    let calibrationState: 'idle' | 'waiting' | 'capturing' | 'success' | 'error' = 'idle';
    let lastResponseFinishedAt = 0;
    let lastResponseFinishedConversationId: string | null = null;

    // -- Manager Initialization --

    // 1. UI Manager
    const buttonManager = new ButtonManager(handleSaveClick, handleCopyClick, handleCalibrationClick);

    // 2. Data Manager
    const interceptionManager = new InterceptionManager((capturedId, data) => {
        currentConversationId = capturedId;
        refreshButtonState(capturedId);
        if (isConversationComplete(data)) {
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
            await runCalibrationCapture();
            return;
        }

        calibrationState = 'waiting';
        buttonManager.setCalibrationState('waiting');
        logger.info('Calibration armed. Click Done when response is complete.');
    }

    function setCalibrationStatus(status: 'idle' | 'waiting' | 'capturing' | 'success' | 'error'): void {
        calibrationState = status;
        buttonManager.setCalibrationState(status);
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

            return !!interceptionManager.getConversation(conversationId);
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
                const captured = await tryCalibrationFetch(conversationId, apiUrl, attempt + 1, adapter.name);
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

    async function waitForPassiveCapture(adapter: LLMPlatform, conversationId: string): Promise<boolean> {
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
            if (hasCapturedConversation(conversationId)) {
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

    async function captureFromSnapshot(adapter: LLMPlatform, conversationId: string): Promise<boolean> {
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

                    if (hasCapturedConversation(conversationId)) {
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

        if (!hasCapturedConversation(conversationId) && isRawCaptureSnapshot(effectiveSnapshot)) {
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

        return hasCapturedConversation(conversationId);
    }

    async function captureFromRetries(adapter: LLMPlatform, conversationId: string): Promise<boolean> {
        const backoff = [0, 1500, 3000, 5000, 8000, 12000];
        return await runCalibrationRetries(adapter, conversationId, backoff);
    }

    async function runCalibrationCapture(): Promise<void> {
        if (calibrationState === 'capturing') {
            return;
        }
        const context = prepareCalibrationContext();
        if (!context) {
            return;
        }
        const { adapter, conversationId } = context;

        setCalibrationStatus('capturing');
        logger.info('Calibration capture started', { conversationId, platform: adapter.name });
        logger.info('Calibration strategy', {
            platform: adapter.name,
            steps: ['queue-flush', 'passive-wait', 'endpoint-retry', 'page-snapshot'],
        });

        interceptionManager.flushQueuedMessages();
        if (hasCapturedConversation(conversationId)) {
            markCalibrationSuccess(conversationId);
            return;
        }

        const passiveCapture = await waitForPassiveCapture(adapter, conversationId);
        if (passiveCapture) {
            markCalibrationSuccess(conversationId);
            logger.info('Calibration passive capture succeeded', { conversationId });
            return;
        }

        const capturedFromRetries = await captureFromRetries(adapter, conversationId);
        if (capturedFromRetries) {
            markCalibrationSuccess(conversationId);
            logger.info('Calibration capture succeeded', { conversationId });
            return;
        }

        const capturedFromSnapshot = await captureFromSnapshot(adapter, conversationId);
        if (capturedFromSnapshot) {
            markCalibrationSuccess(conversationId);
            logger.info('Calibration snapshot capture succeeded', { conversationId });
            return;
        }

        setCalibrationStatus('error');
        refreshButtonState(conversationId);
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
        buttonManager.setCalibrationState(calibrationState);

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

    function handleConversationSwitch(newId: string | null): void {
        if (!newId) {
            currentConversationId = null;
            setTimeout(injectSaveButton, 300);
            return;
        }

        buttonManager.remove();

        // Determine if we need to update adapter (e.g. cross-platform nav? likely not in same tab but good practice)
        const newAdapter = getPlatformAdapter(window.location.href);
        if (newAdapter && currentAdapter && newAdapter.name !== currentAdapter.name) {
            currentAdapter = newAdapter;
            updateManagers();
        }

        setTimeout(injectSaveButton, 500);
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
        const hasData = interceptionManager.getConversation(conversationId);
        const opacity = hasData ? '1' : '0.6';
        buttonManager.setOpacity(opacity);
        logButtonStateIfChanged(conversationId, !!hasData, opacity);
        if (hasData && calibrationState !== 'capturing') {
            calibrationState = 'success';
            buttonManager.setCalibrationState('success');
        } else if (!hasData && calibrationState === 'success') {
            calibrationState = 'idle';
            buttonManager.setCalibrationState('idle');
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
            const hasData = interceptionManager.getConversation(conversationId);
            if (hasData) {
                buttonManager.setOpacity('1');
                logButtonStateIfChanged(conversationId, true, '1');
                return;
            }
            if (attempts < maxAttempts) {
                setTimeout(tick, intervalMs);
            } else {
                logButtonStateIfChanged(conversationId, false, '0.6');
            }
        };

        setTimeout(tick, intervalMs);
    }

    function isConversationComplete(data: ConversationData): boolean {
        const messages = Object.values(data.mapping)
            .map((node) => node.message)
            .filter(
                (message): message is NonNullable<typeof message> => !!message && message.author.role === 'assistant',
            );

        if (messages.length === 0) {
            return false;
        }

        const inProgress = messages.some((message) => message.status === 'in_progress');
        if (inProgress) {
            return false;
        }

        return messages.some((message) => message.status === 'finished_successfully');
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

    function handleResponseFinished(source: 'network' | 'dom', hintedConversationId?: string): void {
        const conversationId = resolveActiveConversationId(hintedConversationId);
        if (!shouldProcessFinishedSignal(conversationId)) {
            return;
        }

        if (conversationId) {
            currentConversationId = conversationId;
        }

        logger.info('Response finished signal', {
            source,
            conversationId,
            calibrationState,
        });

        if (calibrationState === 'waiting') {
            void runCalibrationCapture();
            return;
        }

        if (conversationId) {
            refreshButtonState(conversationId);
            scheduleButtonRefresh(conversationId);
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
        if (message?.type !== 'BLACKIYA_RESPONSE_FINISHED') {
            return false;
        }
        const hintedConversationId = typeof message.conversationId === 'string' ? message.conversationId : undefined;
        handleResponseFinished('network', hintedConversationId);
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
            if (handleResponseFinishedMessage(message)) {
                return;
            }
            handleJsonBridgeRequest(message);
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
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

    // Start listening
    interceptionManager.start();
    navigationManager.start();
    cleanupWindowBridge = registerWindowBridge();
    cleanupCompletionWatcher = registerCompletionWatcher();

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
            interceptionManager.stop();
            navigationManager.stop();
            buttonManager.remove();
            cleanupWindowBridge?.();
            cleanupCompletionWatcher?.();
        } catch (error) {
            logger.debug('Error during cleanup:', error);
        }
    });
}
