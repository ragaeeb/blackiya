import { beforeEach, describe, expect, it } from 'bun:test';
import {
    appendLiveRunnerStreamPreview,
    appendPendingRunnerStreamPreview,
    ensureLiveRunnerStreamPreview,
    mergeRunnerStreamProbeText,
    migratePendingRunnerStreamPreview,
    type RunnerStreamPreviewState,
    removePendingRunnerStreamPreview,
    withPreservedRunnerStreamMirrorSnapshot,
} from '@/utils/runner/stream-preview';

describe('stream-preview', () => {
    let state: RunnerStreamPreviewState;

    beforeEach(() => {
        state = {
            liveByConversation: new Map(),
            liveByAttemptWithoutConversation: new Map(),
            preservedByConversation: new Map(),
            maxEntries: 10,
            maxPreviewLength: 100,
        };
    });

    describe('mergeRunnerStreamProbeText', () => {
        it('should return snapshot style if text starts with current', () => {
            expect(mergeRunnerStreamProbeText('hello', 'hello world')).toBe('hello world');
        });

        it('should return current if current starts with text (stale)', () => {
            expect(mergeRunnerStreamProbeText('hello world', 'hello')).toBe('hello world');
        });

        it('should join with space if word boundary is detected', () => {
            expect(mergeRunnerStreamProbeText('hello', 'World')).toBe('hello World');
        });

        it('should append directly if lowercase continuation', () => {
            expect(mergeRunnerStreamProbeText('hello w', 'orld')).toBe('hello world');
        });

        it('should not add space if ends/starts with whitespace', () => {
            expect(mergeRunnerStreamProbeText('hello\n', 'World')).toBe('hello\nWorld');
            expect(mergeRunnerStreamProbeText('hello ', 'World')).toBe('hello World');
            expect(mergeRunnerStreamProbeText('hello', ' World')).toBe('hello World');
        });
    });

    describe('withPreservedRunnerStreamMirrorSnapshot', () => {
        it('should return primary body if not stream done status', () => {
            expect(withPreservedRunnerStreamMirrorSnapshot(state, 'c-1', 'streaming', 'body')).toBe('body');
        });

        it('should return primary body if no live snapshot', () => {
            expect(withPreservedRunnerStreamMirrorSnapshot(state, 'c-1', 'stream-done: ready', 'body')).toBe('body');
        });

        it('should return primary body if they match', () => {
            state.liveByConversation.set('c-1', 'body');
            expect(withPreservedRunnerStreamMirrorSnapshot(state, 'c-1', 'stream-done:', 'body ')).toBe('body ');
        });

        it('should append preserved snapshot if different', () => {
            state.liveByConversation.set('c-1', 'live snapshot');
            const result = withPreservedRunnerStreamMirrorSnapshot(state, 'c-1', 'stream-done:', 'primary body');
            expect(result).toContain('primary body');
            expect(result).toContain('live snapshot');
            expect(result).toContain('Preserved live mirror snapshot');
            expect(state.preservedByConversation.get('c-1')).toBe('live snapshot');
        });
    });

    describe('pending and live manipulation helpers', () => {
        it('should append, migrate, and remove correctly', () => {
            appendPendingRunnerStreamPreview(state, 'a-1', 'hello');
            expect(state.liveByAttemptWithoutConversation.get('a-1')).toBe('hello');

            appendPendingRunnerStreamPreview(state, 'a-1', ' world');
            expect(state.liveByAttemptWithoutConversation.get('a-1')).toBe('hello world');

            const migrated = migratePendingRunnerStreamPreview(state, 'c-1', 'a-1');
            expect(migrated).toBe('hello world');
            expect(state.liveByConversation.get('c-1')).toBe('hello world');
            expect(state.liveByAttemptWithoutConversation.has('a-1')).toBeFalse();

            appendLiveRunnerStreamPreview(state, 'c-1', '!');
            expect(state.liveByConversation.get('c-1')).toBe('hello world!');

            expect(removePendingRunnerStreamPreview(state, 'a-2')).toBeFalse();
        });

        it('ensureLiveRunnerStreamPreview should init if missing', () => {
            expect(ensureLiveRunnerStreamPreview(state, 'c-1')).toBe('');
            expect(state.liveByConversation.has('c-1')).toBeTrue();
        });

        it('migratePendingRunnerStreamPreview should return null if none', () => {
            expect(migratePendingRunnerStreamPreview(state, 'c-1', 'none')).toBeNull();
        });
    });
});
