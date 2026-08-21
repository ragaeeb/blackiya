import { logger } from '@/utils/logger';

type DownloadDiagnosticTimer = number;

export type DownloadInteractionDiagnosticsDeps = {
    getAdapterName?: () => string | null;
    getConversationId?: () => string | null;
    buttonManagerExists?: () => boolean;
    onDownloadInteraction?: () => void;
    log?: (message: string, details: Record<string, unknown>) => void;
    debugLog?: (message: string, details: Record<string, unknown>) => void;
    schedule?: (callback: () => void, delayMs: number) => DownloadDiagnosticTimer;
    cancel?: (timer: DownloadDiagnosticTimer) => void;
};

const DOWNLOAD_CHECKPOINT_DELAYS_MS = [0, 50, 250, 1000, 2000] as const;
const DOWNLOAD_SIGNAL = /\bdownload\b/i;
export const DOWNLOAD_TEARDOWN_GRACE_MS = 3000;
const CONTROL_IDS = [
    'blackiya-lifecycle-badge',
    'blackiya-save-btn',
    'blackiya-save-markdown-btn',
    'blackiya-force-save-json-btn',
    'blackiya-calibrate-btn',
] as const;

const isElementLike = (value: unknown): value is Element => {
    return (
        !!value &&
        typeof value === 'object' &&
        (value as { nodeType?: number }).nodeType === 1 &&
        typeof (value as { getAttribute?: unknown }).getAttribute === 'function'
    );
};

const readAttribute = (element: Element | null, name: string): string | null => {
    if (!element) {
        return null;
    }
    try {
        return element.getAttribute(name);
    } catch {
        return null;
    }
};

const normalizeText = (value: string | null | undefined): string | null => {
    const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
    return normalized ? normalized.slice(0, 240) : null;
};

const describeElement = (element: Element): Record<string, unknown> => {
    const ancestorChain: string[] = [];
    let current: Element | null = element;
    while (current && ancestorChain.length < 6) {
        const tagName = current.tagName.toLowerCase();
        const id = current.id ? `#${current.id}` : '';
        const className = readAttribute(current, 'class')
            ?.split(/\s+/)
            .filter(Boolean)
            .slice(0, 4)
            .map((value) => `.${value}`)
            .join('');
        ancestorChain.push(`${tagName}${id}${className ?? ''}`);
        current = current.parentElement;
    }

    return {
        tagName: element.tagName,
        id: element.id || null,
        className: readAttribute(element, 'class'),
        text: normalizeText(element.textContent),
        ariaLabel: readAttribute(element, 'aria-label'),
        title: readAttribute(element, 'title'),
        testId: readAttribute(element, 'data-testid'),
        href: readAttribute(element, 'href'),
        download: readAttribute(element, 'download'),
        ancestorChain,
    };
};

const resolveClickableElement = (event: Event): Element | null => {
    const candidates: unknown[] = [];
    if (event.target) {
        candidates.push(event.target);
    }
    if (typeof event.composedPath === 'function') {
        candidates.push(...event.composedPath());
    }

    for (const candidate of candidates) {
        if (!isElementLike(candidate)) {
            continue;
        }
        const closest = candidate.closest?.('button, a, [role="button"]') ?? candidate;
        if (isElementLike(closest)) {
            return closest;
        }
    }
    return null;
};

const isDownloadInteraction = (element: Element): boolean => {
    const signals = [
        normalizeText(element.textContent),
        readAttribute(element, 'aria-label'),
        readAttribute(element, 'title'),
        readAttribute(element, 'data-testid'),
        readAttribute(element, 'download'),
        readAttribute(element, 'href'),
    ]
        .filter((value): value is string => !!value)
        .join(' ');
    return DOWNLOAD_SIGNAL.test(signals);
};

const getDocumentHealth = (initialBody: HTMLElement | null, buttonManagerExists?: () => boolean) => {
    const currentDocument = typeof document !== 'undefined' ? document : null;
    const body = currentDocument?.body ?? null;
    let container: HTMLElement | null = null;
    try {
        container = currentDocument?.querySelector<HTMLElement>('#blackiya-button-container') ?? null;
    } catch {
        container = null;
    }

    const containerConnected = !!container &&
        (typeof currentDocument?.contains === 'function'
            ? currentDocument.contains(container)
            : container.isConnected === true);
    const controlIdsPresent = CONTROL_IDS.reduce<Record<string, boolean>>((result, id) => {
        result[id] = !!currentDocument?.querySelector(`#${id}`);
        return result;
    }, {});

    let controlContainerCount: number | null = null;
    try {
        controlContainerCount = currentDocument?.querySelectorAll('[data-blackiya-controls="1"]').length ?? null;
    } catch {
        controlContainerCount = null;
    }

    return {
        buttonManagerExists: buttonManagerExists ? buttonManagerExists() : null,
        containerPresent: !!container,
        containerConnected,
        containerParent: container?.parentElement?.tagName ?? null,
        containerPosition: readAttribute(container, 'style')?.match(/position:\s*([^;]+)/i)?.[1]?.trim() ?? null,
        controlContainerCount,
        controlIdsPresent,
        bodyPresent: !!body,
        bodyChildCount: body?.children.length ?? null,
        bodyChanged: initialBody !== null ? body !== initialBody : null,
    };
};

const getCurrentUrl = (): string | null => {
    if (typeof window === 'undefined' || typeof window.location?.href !== 'string') {
        return null;
    }
    return window.location.href;
};

export const shouldDeferRunnerTeardownAfterDownload = (
    lastDownloadInteractionAt: number | null,
    now = Date.now(),
    graceMs = DOWNLOAD_TEARDOWN_GRACE_MS,
) => {
    if (lastDownloadInteractionAt === null || now < lastDownloadInteractionAt) {
        return false;
    }
    return now - lastDownloadInteractionAt <= graceMs;
};

export const registerDownloadInteractionDiagnostics = (deps: DownloadInteractionDiagnosticsDeps = {}) => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return () => {};
    }

    const initialBody = document.body;
    const log =
        deps.log ??
        ((message: string, details: Record<string, unknown>) => {
            logger.info(message, details);
        });
    const debugLog =
        deps.debugLog ??
        ((message: string, details: Record<string, unknown>) => {
            logger.debug(message, details);
        });
    const schedule = deps.schedule ?? ((callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs));
    const cancel = deps.cancel ?? ((timer: DownloadDiagnosticTimer) => window.clearTimeout(timer));
    const pendingTimers = new Set<DownloadDiagnosticTimer>();

    const handleClick = (event: Event) => {
        const target = resolveClickableElement(event);
        if (!target || !isDownloadInteraction(target)) {
            return;
        }

        deps.onDownloadInteraction?.();
        log('Download interaction observed', {
            adapter: deps.getAdapterName?.() ?? null,
            conversationId: deps.getConversationId?.() ?? null,
            url: getCurrentUrl(),
            target: describeElement(target),
            health: getDocumentHealth(initialBody, deps.buttonManagerExists),
        });

        for (const delayMs of DOWNLOAD_CHECKPOINT_DELAYS_MS) {
            let timer: DownloadDiagnosticTimer;
            timer = schedule(() => {
                pendingTimers.delete(timer);
                debugLog('Download interaction DOM state', {
                    adapter: deps.getAdapterName?.() ?? null,
                    conversationId: deps.getConversationId?.() ?? null,
                    url: getCurrentUrl(),
                    delayMs,
                    health: getDocumentHealth(initialBody, deps.buttonManagerExists),
                });
            }, delayMs);
            pendingTimers.add(timer);
        }
    };

    document.addEventListener('click', handleClick, true);

    return () => {
        document.removeEventListener('click', handleClick, true);
        for (const timer of pendingTimers) {
            cancel(timer);
        }
        pendingTimers.clear();
    };
};
