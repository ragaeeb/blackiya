import { describe, expect, it } from 'bun:test';
import { prioritizeCalibrationStep } from '@/utils/runner/calibration-runner';
import {
    buildConversationSnapshotFromMessages,
    buildRunnerSnapshotConversationData,
} from '@/utils/runner/dom-snapshot';
import { applyResolvedExportTitle } from '@/utils/runner/export-pipeline';
import { getLifecyclePhasePriority, isRegressiveLifecycleTransition } from '@/utils/runner/lifecycle-manager';
import { dispatchRunnerMessage } from '@/utils/runner/message-bridge';
import { appendStreamProbePreview } from '@/utils/runner/stream-probe';
import type { ConversationData } from '@/utils/types';

describe('runner helper modules', () => {
    it('prioritizes a calibration step while preserving order of remaining steps', () => {
        const order = prioritizeCalibrationStep('endpoint-retry', [
            'queue-flush',
            'passive-wait',
            'endpoint-retry',
            'page-snapshot',
        ]);
        expect(order).toEqual(['endpoint-retry', 'queue-flush', 'passive-wait', 'page-snapshot']);
    });

    it('computes lifecycle priority and regressive transitions deterministically', () => {
        expect(getLifecyclePhasePriority('prompt-sent')).toBe(1);
        expect(getLifecyclePhasePriority('streaming')).toBe(2);
        expect(getLifecyclePhasePriority('completed')).toBe(3);
        expect(getLifecyclePhasePriority('terminated')).toBe(4);
        expect(isRegressiveLifecycleTransition('completed', 'streaming')).toBe(true);
        expect(isRegressiveLifecycleTransition('streaming', 'completed')).toBe(false);
    });

    it('dispatches message handlers until first handler claims the message', () => {
        const calls: string[] = [];
        const handled = dispatchRunnerMessage({ type: 'example' }, [
            () => {
                calls.push('first');
                return false;
            },
            () => {
                calls.push('second');
                return true;
            },
            () => {
                calls.push('third');
                return true;
            },
        ]);
        expect(handled).toBe(true);
        expect(calls).toEqual(['first', 'second']);
    });

    it('appends stream probe preview text with max-length tail cap', () => {
        const merged = appendStreamProbePreview('abc', 'def');
        expect(merged).toBe('abcdef');

        const capped = appendStreamProbePreview('12345', '67890', 8);
        expect(capped).toBe('...67890');

        const cappedWithoutDelta = appendStreamProbePreview('1234567890', '', 8);
        expect(cappedWithoutDelta).toBe('...67890');
    });

    it('builds conversation snapshot data from message candidates', () => {
        const snapshot = buildConversationSnapshotFromMessages('conv-1', 'Sample title', [
            { role: 'user', text: 'hello' },
            { role: 'assistant', text: 'hi there' },
        ]);
        expect(snapshot).not.toBeNull();
        if (!snapshot) {
            return;
        }
        expect(snapshot.conversation_id).toBe('conv-1');
        expect(snapshot.title).toBe('Sample title');
        expect(snapshot.current_node).toBe('snapshot-1');
        expect(snapshot.mapping.root.children).toEqual(['snapshot-0']);
    });

    it('builds runner snapshot conversation payload with platform metadata fields', () => {
        const snapshot = buildRunnerSnapshotConversationData(
            'conv-2',
            'Gemini',
            [
                { role: 'user', text: 'hi' },
                { role: 'assistant', text: 'hello' },
            ],
            'Document title',
        );
        expect(snapshot).not.toBeNull();
        if (!snapshot) {
            return;
        }
        expect(snapshot.title).toBe('Document title');
        expect(snapshot.default_model_slug).toBe('snapshot');
        expect(snapshot.mapping['snapshot-2']?.message?.author.role).toBe('assistant');
    });

    it('returns null for runner snapshot data when conversation id is empty', () => {
        const snapshot = buildRunnerSnapshotConversationData(
            '',
            'Gemini',
            [
                { role: 'user', text: 'hi' },
                { role: 'assistant', text: 'hello' },
            ],
            'Document title',
        );
        expect(snapshot).toBeNull();
    });

    it('applies shared export title policy for generic placeholder titles', () => {
        const data: ConversationData = {
            title: 'Conversation with Gemini',
            create_time: 0,
            update_time: 0,
            conversation_id: 'conv-title',
            current_node: 'assistant-1',
            moderation_results: [],
            plugin_ids: null,
            gizmo_id: null,
            gizmo_type: null,
            is_archived: false,
            default_model_slug: 'unknown',
            safe_urls: [],
            blocked_urls: [],
            mapping: {
                root: { id: 'root', message: null, parent: null, children: ['user-1'] },
                'user-1': {
                    id: 'user-1',
                    parent: 'root',
                    children: ['assistant-1'],
                    message: {
                        id: 'user-1',
                        author: { role: 'user', name: null, metadata: {} },
                        content: { content_type: 'text', parts: ['A very specific prompt title'] },
                        create_time: 1,
                        update_time: 1,
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
                'assistant-1': {
                    id: 'assistant-1',
                    parent: 'user-1',
                    children: [],
                    message: {
                        id: 'assistant-1',
                        author: { role: 'assistant', name: null, metadata: {} },
                        content: { content_type: 'text', parts: ['response'] },
                        create_time: 2,
                        update_time: 2,
                        status: 'finished_successfully',
                        end_turn: true,
                        weight: 1,
                        metadata: {},
                        recipient: 'all',
                        channel: null,
                    },
                },
            },
        };

        const decision = applyResolvedExportTitle(data);
        expect(decision.source).toBe('first-user-message');
        expect(data.title).toContain('A very specific prompt title');
    });

    it('appends unknown calibration step to the tail when step is missing from default order', () => {
        const order = prioritizeCalibrationStep(
            'missing-step' as unknown as Parameters<typeof prioritizeCalibrationStep>[0],
            ['a', 'b', 'c'] as unknown as Parameters<typeof prioritizeCalibrationStep>[1],
        );
        expect(order).toEqual(['a', 'b', 'c', 'missing-step'] as unknown as typeof order);
    });
});
