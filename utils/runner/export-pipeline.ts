import { resolveExportConversationTitleDecision } from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

export function applyResolvedExportTitle(data: ConversationData): { title: string; source: string } {
    const titleDecision = resolveExportConversationTitleDecision(data);
    data.title = titleDecision.title;
    return { title: titleDecision.title, source: titleDecision.source };
}
