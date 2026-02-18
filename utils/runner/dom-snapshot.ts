import type { ConversationData } from '@/utils/types';

export type SnapshotMessageCandidate = {
    role: 'user' | 'assistant';
    text: string;
};

export function buildConversationSnapshotFromMessages(
    conversationId: string,
    title: string,
    messages: SnapshotMessageCandidate[],
): ConversationData | null {
    if (!conversationId || messages.length === 0) {
        return null;
    }

    const now = Date.now() / 1000;
    const mapping: ConversationData['mapping'] = {
        root: { id: 'root', message: null, parent: null, children: [] },
    };

    let parentId = 'root';
    messages.forEach((message, index) => {
        const id = `snapshot-${index}`;
        mapping[parentId]?.children.push(id);
        mapping[id] = {
            id,
            parent: parentId,
            children: [],
            message: {
                id,
                author: { role: message.role, name: null, metadata: {} },
                content: { content_type: 'text', parts: [message.text] },
                create_time: now,
                update_time: now,
                status: 'finished_successfully',
                end_turn: true,
                weight: 1,
                metadata: {},
                recipient: 'all',
                channel: null,
            },
        };
        parentId = id;
    });

    return {
        title: title || 'Conversation',
        create_time: now,
        update_time: now,
        conversation_id: conversationId,
        current_node: parentId,
        moderation_results: [],
        plugin_ids: null,
        gizmo_id: null,
        gizmo_type: null,
        is_archived: false,
        default_model_slug: 'unknown',
        safe_urls: [],
        blocked_urls: [],
        mapping,
    };
}

export function buildRunnerSnapshotConversationData(
    conversationId: string,
    platformName: string,
    messages: SnapshotMessageCandidate[],
    documentTitle?: string,
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
        title: documentTitle || `${platformName} Conversation`,
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
