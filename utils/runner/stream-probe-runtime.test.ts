import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RunnerStreamPreviewState } from '@/utils/runner/stream-preview';
import {
    appendLiveStreamProbeText,
    appendPendingStreamProbeText,
    migratePendingStreamProbeText,
    type StreamProbePanelDeps,
    type SyncStreamProbePanelDeps,
    setStreamProbePanel,
    syncStreamProbePanelFromCanonical,
    withPreservedLiveMirrorSnapshot,
} from '@/utils/runner/stream-probe-runtime';

describe('stream-probe-runtime', () => {
    describe('setStreamProbePanel', () => {
        let originalDocument: any;
        const documentMockElements: Record<string, any> = {};

        beforeEach(() => {
            originalDocument = globalThis.document;
            (globalThis as any).document = {
                getElementById: (id: string) => documentMockElements[id] || null,
                createElement: (_tag: string) => ({
                    style: {},
                    id: '',
                    parentNode: null,
                    textContent: '',
                    appendChild: () => {},
                    removeChild: () => {},
                }),
                body: {
                    appendChild: (el: any) => {
                        documentMockElements[el.id] = el;
                    },
                    removeChild: (el: any) => {
                        delete documentMockElements[el.id];
                    },
                },
            };
        });

        afterEach(() => {
            globalThis.document = originalDocument;
            for (const key of Object.keys(documentMockElements)) {
                delete documentMockElements[key];
            }
        });

        it('should exit if cleaned up or not visible', () => {
            const deps: StreamProbePanelDeps = {
                isCleanedUp: () => true,
                isStreamProbeVisible: () => false,
                getAdapterName: () => 'ChatGPT',
                getHostname: () => 'chatgpt.com',
            };

            setStreamProbePanel('status', 'body', deps);
            expect(Object.keys(documentMockElements).length).toBe(0);
        });

        it('should set panel content if visible', () => {
            const deps: StreamProbePanelDeps = {
                isCleanedUp: () => false,
                isStreamProbeVisible: () => true,
                getAdapterName: () => 'ChatGPT',
                getHostname: () => 'chatgpt.com',
            };

            setStreamProbePanel('status', 'body', deps);
            expect(documentMockElements['blackiya-stream-probe']).toBeDefined();
            expect(documentMockElements['blackiya-stream-probe'].textContent).toContain('status');
        });
    });

    describe('withPreservedLiveMirrorSnapshot', () => {
        it('should defer to underlying stream preview generator', () => {
            const state: RunnerStreamPreviewState = {
                liveByConversation: new Map([['c-1', 'live']]),
                liveByAttemptWithoutConversation: new Map(),
                preservedByConversation: new Map(),
                maxEntries: 10,
            };
            const result = withPreservedLiveMirrorSnapshot(state, 'c-1', 'stream-done:', 'body');
            expect(result).toContain('live');
            expect(result).toContain('body');
        });
    });

    describe('syncStreamProbePanelFromCanonical', () => {
        let oldDoc: any;
        beforeEach(() => {
            oldDoc = globalThis.document;
            (globalThis as any).document = {
                getElementById: mock(() => ({ textContent: 'stream-done: awaiting canonical capture' })) as any,
            };
        });
        afterEach(() => {
            globalThis.document = oldDoc;
        });

        it('should sync if valid', () => {
            const setPanel = mock(() => {});
            const deps: SyncStreamProbePanelDeps = {
                lastStreamProbeConversationId: 'c-1',
                getAdapterName: () => 'ChatGPT',
                setStreamProbePanel: setPanel,
                withPreservedLiveMirrorSnapshot: (_cid, status, body) => `${status} | ${body}`,
            };

            syncStreamProbePanelFromCanonical('c-1', { mapping: {} } as any, deps);
            expect(setPanel).toHaveBeenCalledWith(
                'stream-done: canonical capture ready',
                'stream-done: canonical capture ready | (captured cache ready; no assistant text extracted)',
            );
        });

        it('should skip if conversation id mismatch, wrong panel text, or missing panel', () => {
            const setPanel = mock(() => {});
            const deps: SyncStreamProbePanelDeps = {
                lastStreamProbeConversationId: 'c-2',
                getAdapterName: () => 'ChatGPT',
                setStreamProbePanel: setPanel,
                withPreservedLiveMirrorSnapshot: (_cid, _status, _body) => '',
            };

            syncStreamProbePanelFromCanonical('c-1', { mapping: {} } as any, deps);
            expect(setPanel).not.toHaveBeenCalled();

            deps.lastStreamProbeConversationId = 'c-1';
            (globalThis.document.getElementById as any).mockReturnValueOnce({ textContent: 'stream: live' });
            syncStreamProbePanelFromCanonical('c-1', { mapping: {} } as any, deps);
            expect(setPanel).not.toHaveBeenCalled();
        });
    });

    describe('appendPendingStreamProbeText & migratePendingStreamProbeText & appendLiveStreamProbeText', () => {
        it('should append text and update panel', () => {
            const setPanel = mock(() => {});
            const state: RunnerStreamPreviewState = {
                liveByConversation: new Map(),
                liveByAttemptWithoutConversation: new Map(),
                preservedByConversation: new Map(),
                maxEntries: 10,
            };

            appendPendingStreamProbeText(state, 'a-1', 'hello', setPanel);
            expect(state.liveByAttemptWithoutConversation.get('a-1')).toBe('hello');
            expect(setPanel).toHaveBeenCalledWith('stream: awaiting conversation id', 'hello');

            migratePendingStreamProbeText(state, 'c-1', 'a-1', setPanel);
            expect(state.liveByConversation.get('c-1')).toBe('hello');
            expect(setPanel).toHaveBeenCalledWith('stream: live mirror', 'hello');

            appendLiveStreamProbeText(state, 'c-1', ' world', setPanel);
            expect(state.liveByConversation.get('c-1')).toBe('hello world');
            expect(setPanel).toHaveBeenCalledWith('stream: live mirror', 'hello world');
        });
    });
});
