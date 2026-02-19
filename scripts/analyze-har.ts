import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { analyzeHarContent, renderHarAnalysisMarkdown } from '../utils/har-analysis';

type CliOptions = {
    input: string;
    outputJson: string | null;
    outputMarkdown: string | null;
    hints: string[];
    hostFilter: string[];
    maxBodyChars: number | undefined;
    maxMatchesPerHint: number | undefined;
    snippetRadius: number | undefined;
};

const LARGE_HAR_WARN_BYTES = 25 * 1024 * 1024;

const printUsage = (): void => {
    console.log(
        [
            'Usage:',
            '  bun run scripts/analyze-har.ts --input <path.har> [options]',
            '',
            'Options:',
            '  --input <path>             HAR file path (required, positional also accepted)',
            '  --hint <text>              Hint string to search for (repeatable)',
            '  --host <hostname>          Limit analysis to host(s), e.g. grok.com (repeatable)',
            '  --output <path>            Output JSON path',
            '  --report <path>            Output Markdown report path',
            '  --no-report                Skip Markdown output',
            '  --max-body-chars <n>       Max chars scanned per request/response body',
            '  --max-matches <n>          Max matches kept per hint',
            '  --snippet-radius <n>       Context chars kept around each match',
            '  --help                     Show this help',
            '',
            'Examples:',
            '  bun run scripts/analyze-har.ts logs/grok.com.har --host grok.com --hint "Agents thinking"',
            '  bun run scripts/analyze-har.ts --input logs/grok.com.har --hint "reconnect-response-v2" --hint "load-responses"',
        ].join('\n'),
    );
};

const parseNumber = (raw: string, flag: string): number => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid value for ${flag}: ${raw}`);
    }
    return Math.floor(parsed);
};

const parseArgs = (argv: string[]): CliOptions => {
    let input: string | null = null;
    let outputJson: string | null = null;
    let outputMarkdown: string | null = null;
    const hints: string[] = [];
    const hostFilter: string[] = [];
    let maxBodyChars: number | undefined;
    let maxMatchesPerHint: number | undefined;
    let snippetRadius: number | undefined;
    let reportDisabled = false;

    const expectValue = (index: number, flag: string): string => {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing value for ${flag}`);
        }
        return value;
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }

        if (arg === '--input') {
            input = expectValue(i, '--input');
            i += 1;
            continue;
        }

        if (arg === '--hint') {
            hints.push(expectValue(i, '--hint'));
            i += 1;
            continue;
        }

        if (arg === '--host') {
            hostFilter.push(expectValue(i, '--host').toLowerCase());
            i += 1;
            continue;
        }

        if (arg === '--output') {
            outputJson = expectValue(i, '--output');
            i += 1;
            continue;
        }

        if (arg === '--report') {
            outputMarkdown = expectValue(i, '--report');
            i += 1;
            continue;
        }

        if (arg === '--no-report') {
            reportDisabled = true;
            continue;
        }

        if (arg === '--max-body-chars') {
            maxBodyChars = parseNumber(expectValue(i, '--max-body-chars'), '--max-body-chars');
            i += 1;
            continue;
        }

        if (arg === '--max-matches') {
            maxMatchesPerHint = parseNumber(expectValue(i, '--max-matches'), '--max-matches');
            i += 1;
            continue;
        }

        if (arg === '--snippet-radius') {
            snippetRadius = parseNumber(expectValue(i, '--snippet-radius'), '--snippet-radius');
            i += 1;
            continue;
        }

        if (arg.startsWith('--')) {
            throw new Error(`Unknown flag: ${arg}`);
        }

        if (!input) {
            input = arg;
            continue;
        }

        throw new Error(`Unexpected argument: ${arg}`);
    }

    if (!input) {
        throw new Error('Missing required --input <path.har> argument');
    }

    if (reportDisabled) {
        outputMarkdown = null;
    }

    return {
        input,
        outputJson,
        outputMarkdown,
        hints,
        hostFilter,
        maxBodyChars,
        maxMatchesPerHint,
        snippetRadius,
    };
};

const ensureParentDirectory = async (filePath: string): Promise<void> => {
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });
};

const deriveDefaultPaths = (inputFile: string): { jsonPath: string; markdownPath: string } => {
    const resolvedInput = path.resolve(inputFile);
    const inputDir = path.dirname(resolvedInput);
    const outputDir = path.join(inputDir, 'har-analysis');
    const baseName = path.basename(inputFile).replace(/\.har$/i, '') || 'capture';
    return {
        jsonPath: path.join(outputDir, `${baseName}.analysis.json`),
        markdownPath: path.join(outputDir, `${baseName}.analysis.md`),
    };
};

const run = async (): Promise<void> => {
    const options = parseArgs(process.argv.slice(2));
    const defaults = deriveDefaultPaths(options.input);
    const jsonPath = path.resolve(options.outputJson ?? defaults.jsonPath);
    const markdownPath =
        options.outputMarkdown === null ? null : path.resolve(options.outputMarkdown ?? defaults.markdownPath);

    const inputStat = await stat(options.input);
    if (inputStat.size >= LARGE_HAR_WARN_BYTES) {
        console.warn(
            `Warning: HAR file is ${(inputStat.size / (1024 * 1024)).toFixed(1)}MB; consider --max-body-chars to reduce scan pressure.`,
        );
    }

    const rawHar = await readFile(options.input, 'utf8');
    const analysis = analyzeHarContent(rawHar, {
        hints: options.hints,
        hostFilter: options.hostFilter,
        maxBodyChars: options.maxBodyChars,
        maxMatchesPerHint: options.maxMatchesPerHint,
        snippetRadius: options.snippetRadius,
        sourceFile: path.resolve(options.input),
    });

    await ensureParentDirectory(jsonPath);
    await writeFile(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');

    if (markdownPath) {
        await ensureParentDirectory(markdownPath);
        const markdown = renderHarAnalysisMarkdown(analysis);
        await writeFile(markdownPath, markdown, 'utf8');
    }

    console.log(`HAR analysis complete.`);
    console.log(`Input: ${path.resolve(options.input)}`);
    console.log(`Entries scanned: ${analysis.stats.entriesScanned}/${analysis.stats.totalEntries}`);
    console.log(`Body truncations: ${analysis.stats.bodyTruncationCount}`);
    console.log(`Likely streaming endpoints: ${analysis.likelyStreamingEndpoints.length}`);
    console.log(`Hint matches: ${analysis.stats.hintMatches}`);
    console.log(`JSON report: ${jsonPath}`);
    if (markdownPath) {
        console.log(`Markdown report: ${markdownPath}`);
    }
};

run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`HAR analysis failed: ${message}`);
    printUsage();
    process.exit(1);
});
