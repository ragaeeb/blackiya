import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertMarkdownExports } from './export-markdown';

const exportedConversation = {
    title: 'CLI conversation',
    conversation_id: 'conv-cli',
    current_node: 'assistant',
    mapping: {
        root: { id: 'root', parent: null, children: ['user'], message: null },
        user: {
            id: 'user',
            parent: 'root',
            children: ['assistant'],
            message: {
                id: 'user',
                author: { role: 'user', name: null, metadata: {} },
                content: { content_type: 'text', parts: ['CLI prompt'] },
                status: 'finished_successfully',
                end_turn: true,
                metadata: {},
            },
        },
        assistant: {
            id: 'assistant',
            parent: 'user',
            children: [],
            message: {
                id: 'assistant',
                author: { role: 'assistant', name: null, metadata: {} },
                content: { content_type: 'text', parts: ['CLI answer'] },
                status: 'finished_successfully',
                end_turn: true,
                metadata: { reasoning: 'must not export' },
            },
        },
    },
    __blackiya: { exportMeta: { fidelity: 'high' } },
};

describe('convertMarkdownExports', () => {
    let tempDirectory: string | null = null;

    afterEach(async () => {
        if (tempDirectory) {
            await rm(tempDirectory, { recursive: true, force: true });
            tempDirectory = null;
        }
    });

    it('should convert one exported JSON file to a sibling Markdown file', async () => {
        tempDirectory = await mkdtemp(join(tmpdir(), 'blackiya-markdown-'));
        const input = join(tempDirectory, 'chat.json');
        await Bun.write(input, JSON.stringify(exportedConversation));

        const result = await convertMarkdownExports({ input, output: null });
        const output = join(tempDirectory, 'chat.md');

        expect(result).toEqual({ converted: 1, outputs: [output] });
        expect(await Bun.file(output).text()).toBe(`# CLI conversation

## User

CLI prompt

## Assistant

CLI answer
`);
    });

    it('should recursively convert a directory and preserve relative paths', async () => {
        tempDirectory = await mkdtemp(join(tmpdir(), 'blackiya-markdown-'));
        const input = join(tempDirectory, 'json');
        const output = join(tempDirectory, 'markdown');
        await Bun.write(join(input, 'nested', 'chat.json'), JSON.stringify(exportedConversation));
        await Bun.write(join(input, 'ignore.txt'), 'not JSON');

        const result = await convertMarkdownExports({ input, output });
        const markdownPath = join(output, 'nested', 'chat.md');

        expect(result).toEqual({ converted: 1, outputs: [markdownPath] });
        expect(await Bun.file(markdownPath).text()).toContain('CLI answer');
    });

    it('should reject JSON files that are not conversation exports', async () => {
        tempDirectory = await mkdtemp(join(tmpdir(), 'blackiya-markdown-'));
        const input = join(tempDirectory, 'invalid.json');
        await Bun.write(input, '{"hello":"world"}');

        await expect(convertMarkdownExports({ input, output: null })).rejects.toThrow(
            'Not a Blackiya conversation export',
        );
    });
});
