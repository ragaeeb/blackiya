import { describe, expect, it, mock } from 'bun:test';
import { applyResolvedExportTitle } from '@/utils/runner/export-pipeline';
import type { ConversationData } from '@/utils/types';

mock.module('@/utils/title-resolver', () => ({
    resolveExportConversationTitleDecision: mock((data) => {
        return { title: `Resolved: ${data.title}`, source: 'fallback' };
    }),
}));

describe('export-pipeline', () => {
    describe('applyResolvedExportTitle', () => {
        it('should mutate data.title and return the decision', () => {
            const data = { title: 'Original' } as ConversationData;

            const result = applyResolvedExportTitle(data);

            expect(result).toEqual({ title: 'Resolved: Original', source: 'fallback' });
            expect(data.title).toBe('Resolved: Original');
        });
    });
});
