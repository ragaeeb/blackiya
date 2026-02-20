import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { applyResolvedExportTitle } from '@/utils/runner/export-pipeline';
import * as titleResolver from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

describe('export-pipeline', () => {
    let titleSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        titleSpy = spyOn(titleResolver, 'resolveExportConversationTitleDecision').mockImplementation((data) => {
            return { title: `Resolved: ${data.title}`, source: 'fallback' };
        });
    });

    afterEach(() => {
        titleSpy.mockRestore();
    });

    describe('applyResolvedExportTitle', () => {
        it('should mutate data.title and return the decision', () => {
            const data = { title: 'Original' } as ConversationData;

            const result = applyResolvedExportTitle(data);

            expect(result).toEqual({ title: 'Resolved: Original', source: 'fallback' });
            expect(data.title).toBe('Resolved: Original');
        });
    });
});
