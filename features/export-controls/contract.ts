export const EXPORT_CONTROLS_CONTAINER_ID = 'blackiya-v3-export-controls';
export const EXPORT_CONTROLS_CONTAINER_ATTR = 'data-blackiya-export-controls';
export const EXPORT_CHAT_BUTTON_ID = 'blackiya-v3-export-chat-btn';
export const EXPORT_ERROR_KIND_ATTR = 'data-blackiya-error-kind';

export const EXPORT_SUCCESS_RESET_MS = 2000;
export const EXPORT_ERROR_RESET_MS = 2500;

export type ExportControlsState = 'idle' | 'loading' | 'success' | 'error';

export type ExportActionContext = {
    platform: string;
    conversationId: string | null;
};

export type ExportControlsDependencies = {
    resolveActionContext: () => ExportActionContext;
    onExport: (context: ExportActionContext) => Promise<void>;
};

export type ExportControlsTimings = {
    successResetMs: number;
    errorResetMs: number;
};

export type ExportControls = {
    mount: () => HTMLElement;
    destroy: () => void;
    getElement: () => HTMLElement | null;
    getButton: () => HTMLButtonElement | null;
    getState: () => ExportControlsState;
};

export const DESCOPED_CONTROL_IDS = [
    'blackiya-lifecycle-badge',
    'blackiya-save-btn',
    'blackiya-save-markdown-btn',
    'blackiya-force-save-json-btn',
    'blackiya-calibrate-btn',
] as const;

const DEFAULT_TIMINGS: ExportControlsTimings = {
    successResetMs: EXPORT_SUCCESS_RESET_MS,
    errorResetMs: EXPORT_ERROR_RESET_MS,
};

export const defaultExportControlsTimings = (): ExportControlsTimings => ({ ...DEFAULT_TIMINGS });
