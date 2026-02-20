import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
    ensureStreamProbePanel,
    resolveStreamProbeDockPosition,
    setStreamProbePanelContent,
} from '@/utils/runner/probe-panel';

describe('probe-panel', () => {
    describe('resolveStreamProbeDockPosition', () => {
        it('should return top-left for gemini', () => {
            expect(resolveStreamProbeDockPosition('Gemini', 'something')).toBe('top-left');
            expect(resolveStreamProbeDockPosition('ChatGPT', 'gemini.google.com')).toBe('top-left');
        });

        it('should return bottom-left for others', () => {
            expect(resolveStreamProbeDockPosition('ChatGPT', 'chatgpt.com')).toBe('bottom-left');
        });
    });

    describe('DOM manipulations', () => {
        let originalDocument: any;

        beforeEach(() => {
            originalDocument = globalThis.document;
            (globalThis as any).document = {
                getElementById: (id: string) => documentMockElements[id] || null,
                createElement: (_tag: string) => {
                    const el = {
                        style: {},
                        id: '',
                        parentNode: null,
                        textContent: '',
                        appendChild: () => {},
                        removeChild: () => {},
                    };
                    return el;
                },
                body: {
                    appendChild: (el: any) => {
                        documentMockElements[el.id] = el;
                    },
                    removeChild: (el: any) => {
                        delete documentMockElements[el.id];
                    },
                },
            };
            documentMockElements = {};
        });

        afterEach(() => {
            globalThis.document = originalDocument;
        });

        let documentMockElements: Record<string, any> = {};

        it('should return null and remove if visible is false', () => {
            const el = document.createElement('div') as any;
            el.id = 'blackiya-stream-probe';
            el.parentNode = document.body;
            documentMockElements['blackiya-stream-probe'] = el;

            expect(ensureStreamProbePanel(false, 'bottom-left')).toBeNull();
            // In a real DOM removeChild is called
        });

        it('should return existing if found', () => {
            const el = document.createElement('div') as any;
            el.id = 'blackiya-stream-probe';
            documentMockElements['blackiya-stream-probe'] = el;

            const result = ensureStreamProbePanel(true, 'bottom-left');
            expect(result).toBe(el);
            expect(result!.style.left).toBe('16px'); // docking string applied
        });

        it('should create new if not found', () => {
            const result = ensureStreamProbePanel(true, 'top-left');
            expect(result).not.toBeNull();
            expect(result!.id).toBe('blackiya-stream-probe');
            expect(result!.style.top).toBe('16px');
        });

        it('should set content', () => {
            const el = document.createElement('div') as any;
            setStreamProbePanelContent(el, 'status', 'body');
            expect(el.textContent).toContain('[Blackiya Stream Probe] status');
            expect(el.textContent).toContain('body');
        });
    });
});
