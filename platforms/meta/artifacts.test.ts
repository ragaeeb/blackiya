import { describe, expect, it } from 'bun:test';
import {
    extractMetaArtifactContentFromScripts,
    ingestMetaArtifactMessageEvent,
    META_ARTIFACT_MESSAGE_TYPE,
    parseMetaArtifactRequest,
} from './artifacts';
import { SYNTHETIC_META_CONVERSATION_ID } from './fixtures/conversation';

const SYNTHETIC_ARTIFACT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MARKDOWN_BODY =
    '# 0. Run Metadata\nProvides kunya resolution and grade mapping\ncomputed from 4.4M edges, teacher/student\n';

const flightScript = (payload: string) => {
    const bytes = new TextEncoder().encode(payload);
    const row = `9:X\n10:T${bytes.byteLength.toString(16)},${payload}5:["$","$Lf",null,{"content":"$10"}]\n`;
    return { textContent: `self.__next_f.push(${JSON.stringify([1, row])})` };
};

describe('Meta Muse artifact capture', () => {
    it('should classify markdown and document artifact iframe URLs', () => {
        expect(
            parseMetaArtifactRequest(
                `https://1278445752024096.a.metaaiusercontent.com/markdown?artifact_uuid=${SYNTHETIC_ARTIFACT_UUID}&ext=1&hash=x`,
            ),
        ).toEqual({ kind: 'markdown', artifactUuid: SYNTHETIC_ARTIFACT_UUID });
        expect(
            parseMetaArtifactRequest(
                `https://1278446572024014.a.metaaiusercontent.com/document?artifact_uuid=${SYNTHETIC_ARTIFACT_UUID}`,
            ),
        ).toEqual({ kind: 'document', artifactUuid: SYNTHETIC_ARTIFACT_UUID });
        expect(
            parseMetaArtifactRequest(
                `https://evil.example/markdown?artifact_uuid=${SYNTHETIC_ARTIFACT_UUID}`,
            ),
        ).toBeNull();
        expect(parseMetaArtifactRequest('https://www.meta.ai/prompt/not-an-artifact')).toBeNull();
    });

    it('should extract markdown Flight T-chunks and recover JSON from highlighted HTML', () => {
        expect(
            extractMetaArtifactContentFromScripts([flightScript(MARKDOWN_BODY)], 1024 * 1024),
        ).toBe(MARKDOWN_BODY);

        const json = '{\n  "edges": 4400000,\n  "research_prompt_id": "0001"\n}';
        const html = `<pre class="shiki"><span>{</span><span>\n  "edges": 4400000,\n  "research_prompt_id": "0001"\n</span><span>}</span></pre>`;
        const extracted = extractMetaArtifactContentFromScripts([flightScript(html)], 1024 * 1024);
        expect(extracted).toBe(json);
        expect(JSON.parse(extracted ?? '')).toEqual({
            edges: 4400000,
            research_prompt_id: '0001',
        });
    });

    it('should accept artifact posts only from Meta usercontent iframe origins', () => {
        const parent = {};
        const ingested: Array<{ uuid: string; content: string }> = [];
        const ingest = (uuid: string, content: string) => {
            ingested.push({ uuid, content });
        };

        expect(
            ingestMetaArtifactMessageEvent(
                {
                    origin: 'https://1278445752024096.a.metaaiusercontent.com',
                    source: {},
                    data: {
                        type: META_ARTIFACT_MESSAGE_TYPE,
                        artifactUuid: SYNTHETIC_ARTIFACT_UUID,
                        content: MARKDOWN_BODY,
                    },
                },
                parent,
                ingest,
            ),
        ).toBeTrue();
        expect(ingested).toEqual([{ uuid: SYNTHETIC_ARTIFACT_UUID, content: MARKDOWN_BODY }]);

        expect(
            ingestMetaArtifactMessageEvent(
                {
                    origin: 'https://www.meta.ai',
                    source: parent,
                    data: {
                        type: META_ARTIFACT_MESSAGE_TYPE,
                        artifactUuid: SYNTHETIC_ARTIFACT_UUID,
                        content: MARKDOWN_BODY,
                    },
                },
                parent,
                ingest,
            ),
        ).toBeFalse();
        expect(
            ingestMetaArtifactMessageEvent(
                {
                    origin: 'https://evil.example',
                    source: {},
                    data: {
                        type: META_ARTIFACT_MESSAGE_TYPE,
                        artifactUuid: SYNTHETIC_ARTIFACT_UUID,
                        content: MARKDOWN_BODY,
                    },
                },
                parent,
                ingest,
            ),
        ).toBeFalse();
        expect(ingested).toHaveLength(1);
    });

    it('should ignore artifact URLs whose conversation-shaped uuid is invalid', () => {
        expect(
            parseMetaArtifactRequest(
                `https://1278445752024096.a.metaaiusercontent.com/markdown?artifact_uuid=${SYNTHETIC_META_CONVERSATION_ID.slice(0, 8)}`,
            ),
        ).toBeNull();
    });
});
