/**
 * Minimal Logs Export
 *
 * Token-optimized debug report for AI agents. Deduplicates by (platform, convId),
 * strips timestamps/levels, no emojis. Context shortened to [i].
 *
 * @module utils/minimal-logs
 */

import type { LogEntry } from './logs-storage';

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
const SHORT_HEX_ID_RE = /\b[a-f0-9]{16}\b/i;

function extractConvId(msg: string): string | null {
    const m = msg.match(UUID_RE);
    if (m) {
        return m[0];
    }
    const short = msg.match(SHORT_HEX_ID_RE);
    return short ? short[0] : null;
}

function extractConvIdFromData(data: unknown): string | null {
    if (data == null) {
        return null;
    }
    const serialized = typeof data === 'string' ? data : JSON.stringify(data);
    return extractConvId(serialized);
}

const PREFIX_RE = /^\[\w+\]\s*/;

function extractPlatform(msg: string): string | null {
    const afterBracket = msg.replace(PREFIX_RE, '').trim();
    const parts = afterBracket.split(/\s+/);
    if (afterBracket.startsWith('API match ') && parts[2]) {
        return parts[2];
    }
    if (parts[0] === 'trigger' && parts[1]) {
        return parts[1];
    }
    return null;
}

function isSessionStart(msg: string): boolean {
    const s = msg.replace(PREFIX_RE, '').trim();
    return s.startsWith('API match ') || s.startsWith('trigger ');
}

function normalizeLine(msg: string): string {
    return msg.replace(PREFIX_RE, '').trim();
}

function isInterceptorMessage(msg: string): boolean {
    // Include interceptor logs, content script logs, discovery logs, and platform-specific logs
    return (
        msg.includes('[i]') ||
        msg.includes('[interceptor]') ||
        msg.includes('[DISCOVERY]') ||
        msg.includes('[Blackiya/') ||
        msg.includes('Received intercepted data') ||
        msg.includes('Successfully captured') ||
        msg.includes('captured/cached') ||
        msg.includes('Failed to parse')
    );
}

function isNoiseLine(line: string): boolean {
    const isUnmatchedIntercept = line.includes('Intercepted XHR:') && line.includes('Adapter: None');
    if (isUnmatchedIntercept) {
        return false;
    }
    // Filter out verbose debug messages that don't add value
    return (
        line.includes('Fetch intercepted') ||
        line.includes('API adapter:') ||
        line.includes('Completion adapter:') ||
        line.includes('Intercepted XHR:') ||
        line.includes('[Blackiya/Grok] Extracting ID from grok.com URL:') ||
        line.includes('[Blackiya/Grok] Extracted ID:') ||
        line.includes('[NavigationManager] URL change detected:') ||
        line.startsWith('Has ') ||
        line.includes('Response text preview') ||
        line.includes('Full response text')
    );
}

function isCriticalLine(line: string): boolean {
    // Keep lines that indicate success/failure or important state changes
    return (
        line.includes('[DISCOVERY]') ||
        line.includes('Successfully captured') ||
        line.includes('captured/cached') ||
        line.includes('SFE lifecycle phase update') ||
        line.includes('SFE canonical sample processed') ||
        line.includes('Legacy/SFE readiness mismatch') ||
        line.includes('Attempt disposed') ||
        line.includes('Attempt binding created') ||
        line.includes('Attempt superseded by newer prompt') ||
        line.includes('Capture reached ready state') ||
        line.includes('readiness_timeout_manual_only') ||
        line.includes('snapshot_degraded_mode_used') ||
        line.includes('attempt_alias_forwarded') ||
        line.includes('late_signal_dropped_after_dispose') ||
        line.includes('force_save_degraded_export') ||
        line.includes('Awaiting canonical stabilization before ready') ||
        line.includes('Stream done probe canceled') ||
        line.includes('response finished hint') ||
        line.includes('Response finished signal') ||
        line.includes('Calibration ') ||
        line.includes('fetch response') ||
        line.includes('fetch err') ||
        line.includes('fetch gave up') ||
        line.includes('No currentAdapter') ||
        line.includes('Failed to parse') ||
        line.includes('Button state') ||
        line.includes('Button target missing') ||
        line.includes('Button skipped') ||
        line.includes('Stabilization retry') ||
        line.includes('stabilization retry') ||
        line.includes('Warm fetch') ||
        line.includes('warm fetch') ||
        line.includes('Snapshot retry') ||
        line.includes('Promoting ready snapshot') ||
        line.includes('Snapshot promotion skipped') ||
        line.includes('Fresh snapshot promoted') ||
        line.includes('RESPONSE_FINISHED rejected') ||
        line.includes('RESPONSE_FINISHED promoted lifecycle') ||
        line.includes('Re-requesting fresh snapshot') ||
        line.includes('lifecycle signal') ||
        line.includes('canonical_stabilization') ||
        line.includes('disposeInFlight') ||
        line.includes('shouldProcessFinished') ||
        line.includes('handleConversationSwitch') ||
        line.includes('clearCanonicalStabilization') ||
        line.includes('Network source: marking canonical') ||
        line.includes('Conversation switch') ||
        line.includes('Tab became visible') ||
        line.includes('[InterceptionManager]') ||
        line.includes('fetch wrapper alive') ||
        line.includes('parseInterceptedData entry') ||
        line.includes('Gemini endpoint unmatched by adapter') ||
        line.includes('Gemini lifecycle suppressed for non-generation endpoint') ||
        line.includes('Gemini fetch stream monitor start') ||
        line.includes('Gemini fetch stream progress') ||
        line.includes('Gemini stream candidate emitted') ||
        line.includes('Gemini conversation resolved from stream') ||
        line.includes('Gemini XHR stream monitor start') ||
        line.includes('Gemini XHR stream progress') ||
        line.includes('Gemini XHR conversation resolved from stream')
    );
}

function pickFallbackDiagnosticLines(logs: LogEntry[]): string[] {
    const patterns = [
        'Content script running for',
        'Runner init',
        'NavigationManager started',
        'Save/Copy buttons injected',
        'Calibration',
        'Button state',
        'Button target missing',
        'Button skipped',
        'No data captured for this conversation yet',
        'No currentAdapter in manager',
        'Intercepted XHR:',
        'Intercepted fetch:',
        'Adapter: None',
        'API skip conversation URL',
        'XHR skip conversation URL',
        'Background service worker started',
        '[InterceptionManager]',
        'fetch wrapper alive',
        'Gemini endpoint unmatched by adapter',
        'Gemini lifecycle suppressed for non-generation endpoint',
        'Gemini fetch stream monitor start',
        'Gemini fetch stream progress',
        'Gemini stream candidate emitted',
        'Gemini conversation resolved from stream',
        'Gemini XHR stream monitor start',
        'Gemini XHR stream progress',
        'Gemini XHR conversation resolved from stream',
    ];

    const picked = logs
        .map((entry) => {
            const line = normalizeLine(entry.message);
            if (!patterns.some((pattern) => line.includes(pattern))) {
                return null;
            }
            if (entry.data && entry.data.length > 0 && entry.data[0]) {
                const dataStr =
                    typeof entry.data[0] === 'object' ? JSON.stringify(entry.data[0]) : String(entry.data[0]);
                return `${line} ${dataStr}`;
            }
            return line;
        })
        .filter((line): line is string => !!line);

    const unique = Array.from(new Set(picked));
    return unique.slice(Math.max(0, unique.length - 20));
}

interface SessionGroup {
    platform: string;
    convId: string | null;
    events: string[];
    count: number;
}

type RawSession = { platform: string; convId: string | null; events: string[] };

function processLogEntry(
    entry: LogEntry,
    _current: RawSession | null,
): { action: 'skip' } | { action: 'start'; session: RawSession } | { action: 'append'; line: string } {
    const msg = entry.message;
    const line = normalizeLine(msg);

    if (!isInterceptorMessage(msg) && !isCriticalLine(line)) {
        return { action: 'skip' };
    }

    // Always keep critical lines (success/failure indicators)
    if (isCriticalLine(line)) {
        if (isSessionStart(msg)) {
            const platform = extractPlatform(msg) ?? 'Unknown';
            const convId = extractConvId(msg);
            return { action: 'start', session: { platform, convId, events: [line] } };
        }
        return { action: 'append', line };
    }

    // Filter out noise
    if (isNoiseLine(line)) {
        return { action: 'skip' };
    }

    if (isSessionStart(msg)) {
        const platform = extractPlatform(msg) ?? 'Unknown';
        const convId = extractConvId(msg);
        return { action: 'start', session: { platform, convId, events: [line] } };
    }
    return { action: 'append', line };
}

function dedupeByPlatformConvId(sessions: RawSession[]): SessionGroup[] {
    const key = (g: RawSession) => `${g.platform}\n${g.convId ?? ''}`;
    const map = new Map<string, { platform: string; convId: string | null; events: string[]; count: number }>();
    for (const s of sessions) {
        const k = key(s);
        const existing = map.get(k);
        if (!existing) {
            map.set(k, { ...s, count: 1 });
        } else {
            existing.count += 1;
            const merged = existing.events.concat(s.events);
            existing.events = Array.from(new Set(merged));
        }
    }
    return [...map.values()];
}

function appendEntryData(line: string, entry: LogEntry): string {
    if (!entry.data || entry.data.length === 0 || !entry.data[0]) {
        return line;
    }
    const dataStr = typeof entry.data[0] === 'object' ? JSON.stringify(entry.data[0]) : String(entry.data[0]);
    return `${line} ${dataStr}`;
}

function processAppendResult(current: RawSession | null, entry: LogEntry, line: string): void {
    if (!current) {
        return;
    }
    const fullLine = appendEntryData(line, entry);
    const lastLine = current.events[current.events.length - 1];
    if (lastLine !== fullLine) {
        current.events.push(fullLine);
    }
    if (!current.convId) {
        const id = extractConvId(entry.message);
        if (id) {
            current.convId = id;
            return;
        }
        if (entry.data?.length) {
            for (const item of entry.data) {
                const fromData = extractConvIdFromData(item);
                if (fromData) {
                    current.convId = fromData;
                    return;
                }
            }
        }
    }
}

function buildSessionGroups(logs: LogEntry[]): SessionGroup[] {
    const rawSessions: RawSession[] = [];
    let current: RawSession | null = null;

    for (const entry of logs) {
        const result = processLogEntry(entry, current);
        if (result.action === 'skip') {
            continue;
        }
        if (result.action === 'start') {
            current = result.session;
            rawSessions.push(current);
            continue;
        }
        processAppendResult(current, entry, result.line);
    }

    return dedupeByPlatformConvId(rawSessions);
}

function buildEmptyReport(logs: LogEntry[]): string {
    const fallbackDiagnostics = pickFallbackDiagnosticLines(logs);
    const lines = [
        '# Blackiya Debug Report',
        '',
        'No interception sessions. Interceptor may be inactive or no LLM API calls.',
    ];

    if (fallbackDiagnostics.length > 0) {
        lines.push('');
        lines.push('## Diagnostics');
        lines.push('');
        for (const line of fallbackDiagnostics) {
            lines.push(`  ${line}`);
        }
    }

    return lines.join('\n');
}

function buildSessionSection(groups: SessionGroup[]): string[] {
    const lines: string[] = [
        '# Blackiya Debug Report',
        '',
        `Sessions: ${groups.length} (deduped by platform+convId)`,
        '',
    ];

    for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const title = g.convId ? `${g.platform} ${g.convId.slice(0, 8)}` : g.platform;
        lines.push(`## ${i + 1}. ${title}${g.count > 1 ? ` ×${g.count}` : ''}`);
        lines.push('');
        for (const e of g.events) {
            lines.push(`  ${e}`);
        }
        lines.push('');
    }

    return lines;
}

function appendErrorSection(lines: string[], logs: LogEntry[]): void {
    const errors = logs.filter(
        (e) => e.level === 'error' && (e.message.includes('[i]') || e.message.includes('[interceptor]')),
    );
    if (errors.length === 0) {
        return;
    }

    lines.push('## Errors');
    lines.push('');
    for (const e of errors) {
        const line = normalizeLine(e.message);
        lines.push(`  ERR ${line}`);
        if (e.data?.length) {
            const summary = e.data.map((d: any) => d?.message ?? d?.name ?? JSON.stringify(d)).join('; ');
            lines.push(`      ${summary}`);
        }
    }
    lines.push('');
}

/**
 * Generate minimal debug report: deduplicated, no emojis, [i] context.
 * Includes compact timestamps (seconds from start) for timing analysis.
 */
export function generateMinimalDebugReport(logs: LogEntry[]): string {
    const groups = buildSessionGroups(logs);

    if (groups.length === 0) {
        return buildEmptyReport(logs);
    }

    const lines = buildSessionSection(groups);
    appendErrorSection(lines, logs);

    return lines.join('\n');
}

export function downloadMinimalDebugReport(logs: LogEntry[]): void {
    const report = generateMinimalDebugReport(logs);
    const blob = new Blob([report], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const link = document.createElement('a');
    link.href = url;
    link.download = `blackiya-debug-${timestamp}.txt`;
    link.click();
    URL.revokeObjectURL(url);
}
