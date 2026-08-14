import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { conversationToMarkdown } from '@/utils/markdown-transcript';
import type { ConversationData } from '@/utils/types';

type ConvertMarkdownOptions = {
    input: string;
    output: string | null;
};

type ConvertMarkdownResult = {
    converted: number;
    outputs: string[];
};

const isConversationExport = (value: unknown): value is ConversationData => {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        typeof record.conversation_id === 'string' &&
        typeof record.current_node === 'string' &&
        !!record.mapping &&
        typeof record.mapping === 'object' &&
        !Array.isArray(record.mapping)
    );
};

const readConversationExport = async (path: string): Promise<ConversationData> => {
    let parsed: unknown;
    try {
        parsed = await Bun.file(path).json();
    } catch (error) {
        throw new Error(`Failed to parse JSON export: ${path}`, { cause: error });
    }
    if (!isConversationExport(parsed)) {
        throw new Error(`Not a Blackiya conversation export: ${path}`);
    }
    return parsed;
};

const markdownFilename = (jsonFilename: string): string => `${basename(jsonFilename, extname(jsonFilename))}.md`;

const convertFile = async (input: string, output: string) => {
    const conversation = await readConversationExport(input);
    await mkdir(dirname(output), { recursive: true });
    await Bun.write(output, conversationToMarkdown(conversation));
};

export const convertMarkdownExports = async (options: ConvertMarkdownOptions): Promise<ConvertMarkdownResult> => {
    const input = resolve(options.input);
    const inputStats = await stat(input);

    if (inputStats.isFile()) {
        if (extname(input).toLowerCase() !== '.json') {
            throw new Error(`Input file must use the .json extension: ${input}`);
        }
        const output = options.output
            ? extname(options.output).toLowerCase() === '.md'
                ? resolve(options.output)
                : resolve(options.output, markdownFilename(input))
            : join(dirname(input), markdownFilename(input));
        await convertFile(input, output);
        return { converted: 1, outputs: [output] };
    }

    if (!inputStats.isDirectory()) {
        throw new Error(`Input must be a JSON file or directory: ${input}`);
    }

    const outputRoot = options.output ? resolve(options.output) : join(input, 'markdown');
    const glob = new Bun.Glob('**/*.json');
    const relativeInputs = [...glob.scanSync({ cwd: input, onlyFiles: true })].sort();
    const outputs: string[] = [];

    for (const relativeInput of relativeInputs) {
        const inputPath = join(input, relativeInput);
        const outputPath = join(outputRoot, dirname(relativeInput), markdownFilename(relativeInput));
        await convertFile(inputPath, outputPath);
        outputs.push(outputPath);
    }

    return { converted: outputs.length, outputs };
};

const parseCliOptions = (args: string[]): ConvertMarkdownOptions => {
    let input: string | null = null;
    let output: string | null = null;

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--input') {
            input = args[index + 1] ?? null;
            index += 1;
            continue;
        }
        if (argument === '--output') {
            output = args[index + 1] ?? null;
            index += 1;
            continue;
        }
        if (argument === '--help') {
            console.log(
                [
                    'Usage:',
                    '  bun run export:markdown --input <chat.json|directory> [--output <path>]',
                    '',
                    'Examples:',
                    '  bun run export:markdown --input chat.json',
                    '  bun run export:markdown --input exports/ --output markdown/',
                ].join('\n'),
            );
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${argument}`);
    }

    if (!input) {
        throw new Error('Missing required --input <chat.json|directory>');
    }
    return { input, output };
};

if (import.meta.main) {
    const result = await convertMarkdownExports(parseCliOptions(Bun.argv.slice(2)));
    console.log(`Converted ${result.converted} conversation export(s).`);
    for (const output of result.outputs) {
        console.log(relative(process.cwd(), output));
    }
}
