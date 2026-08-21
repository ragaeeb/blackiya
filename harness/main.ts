import { createExportControls } from '@/features/export-controls/export-controls';
import { performSingleExport } from '@/features/single-export/single-export-service';
import { createChatGPTAdapter } from '@/platforms/chatgpt';
import { simulateChatGPTArtifactDownload } from './fixture';

const target = <T extends Element>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) {
        throw new Error(`Harness element not found: ${selector}`);
    }
    return element;
};

const parseHarnessConversationId = (url: string): string | null =>
    url.match(/\/c\/([a-f0-9-]+)/i)?.[1] ?? null;

const createHarnessAdapter = () => {
    const adapter = createChatGPTAdapter();
    return {
        ...adapter,
        isPlatformUrl: () => true,
        extractConversationId: (url: string) => parseHarnessConversationId(url),
        buildApiUrl: (conversationId: string) =>
            `${window.location.origin}/backend-api/conversation/${conversationId}`,
        buildApiUrls: (conversationId: string) => [
            `${window.location.origin}/backend-api/conversation/${conversationId}`,
        ],
    };
};

class BrowserHarness {
    private readonly adapter = createHarnessAdapter();
    private readonly logElement = target<HTMLDivElement>('#harness-event-log');
    private readonly downloadElement = target<HTMLParagraphElement>('#harness-download-output');
    private readonly controls = createExportControls({
        resolveActionContext: () => ({
            platform: this.adapter.name,
            conversationId: this.adapter.extractConversationId(window.location.href),
        }),
        onExport: () => this.forceSave(),
    });

    public mount() {
        target<HTMLButtonElement>('#harness-reset').addEventListener('click', () => this.reset());
        target<HTMLButtonElement>('#harness-force-save').addEventListener('click', () => this.clickForceSave());
        target<HTMLButtonElement>('#harness-download-file').addEventListener('click', () => this.openArtifactPreview());
        this.reset();
    }

    private reset() {
        this.controls.destroy();
        this.controls.mount();
        target<HTMLElement>('#harness-artifact-preview').hidden = true;
        this.downloadElement.textContent = '';
        this.log('Mounted the v3 single-button control. No lifecycle state machine is active.');
    }

    private clickForceSave() {
        target<HTMLButtonElement>('#blackiya-v3-export-chat-btn').click();
    }

    private async forceSave() {
        const result = await performSingleExport(undefined, {
            resolveAdapter: () => this.adapter,
            getPageUrl: () => window.location.href,
            getAuthHeaders: () => undefined,
            fetchImpl: fetch,
            downloadJson: (jsonString: string, filename: string) => {
                this.downloadElement.textContent = `JSON export ready: ${filename}.json (${jsonString.length} bytes)`;
            },
        });
        if (result.kind === 'failure') {
            throw new Error(`${result.error.kind}: ${'reason' in result.error ? result.error.reason : 'request failed'}`);
        }
        this.log(`Force Save fetched the canonical payload (${Object.keys(result.data.mapping).length} nodes).`);
    }

    private openArtifactPreview() {
        simulateChatGPTArtifactDownload(document);
        const control = document.querySelector('#blackiya-v3-export-chat-btn');
        this.log(
            control?.isConnected
                ? 'Download review-ledger.json replaced the page host; v3 controls remained connected.'
                : 'Download review-ledger.json removed the v3 control unexpectedly.',
        );
    }

    private log(message: string) {
        const line = document.createElement('div');
        line.textContent = `${new Date().toLocaleTimeString()} ${message}`;
        this.logElement.prepend(line);
    }
}

new BrowserHarness().mount();
