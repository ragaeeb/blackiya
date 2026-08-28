export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * v3 keeps diagnostics in the explicit stream-debug export. The legacy
 * persistent console logger is intentionally silent so parser misses and
 * expected fail-fast paths do not pollute the host page console.
 */
export const logger = {
    debug: (..._args: unknown[]) => undefined,
    info: (..._args: unknown[]) => undefined,
    warn: (..._args: unknown[]) => undefined,
    error: (..._args: unknown[]) => undefined,
    setLevel: (_level: LogLevel) => undefined,
};
