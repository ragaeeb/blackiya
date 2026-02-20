import { type ExportTitleSource, resolveExportConversationTitleDecision } from '@/utils/title-resolver';
import type { ConversationData } from '@/utils/types';

export const applyResolvedExportTitle = (data: ConversationData): { title: string; source: ExportTitleSource } => {
    const titleDecision = resolveExportConversationTitleDecision(data);
    data.title = titleDecision.title;
    return { title: titleDecision.title, source: titleDecision.source };
};
