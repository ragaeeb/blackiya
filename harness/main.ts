import { performSingleExport } from '@/features/single-export/single-export-service';
import { createChatGPTAdapter } from '@/platforms/chatgpt';
import { HARNESS_CONVERSATION_ID, simulateChatGPTArtifactDownload } from './fixture';

const target = <T extends Element>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) {
        throw new Error(`Harness element not found: ${selector}`);
    }
    return element;
};

const resolveMode = (): 'success' | 'not-terminal' =>
    new URL(window.location.href).searchParams.get('mode') === 'not-terminal' ? 'not-terminal' : 'success';

const parseConversationId = (url: string): string | null => {
    try {
        return url.match(/\/c\/([a-f0-9-]+)/i)?.[1] ?? null;
    } catch {
        return null;
    }
};

const createHarnessAdapter = () => {
    const adapter = createChatGPTAdapter();
    const buildHarnessApiUrl = (conversationId: string) => {
        const endpoint = new URL(`/backend-api/conversation/${conversationId}`, window.location.origin);
        endpoint.searchParams.set('mode', resolveMode());
        return endpoint.toString();
    };

    return {
        ...adapter,
        isPlatformUrl: () => true,
        extractConversationId: parseConversationId,
        buildApiUrl: buildHarnessApiUrl,
        buildApiUrls: (conversationId: string) => [buildHarnessApiUrl(conversationId)],
    };
};

class BrowserHarness {
    private readonly adapter = createHarnessAdapter();
    private readonly saveButton = target<HTMLButtonElement>('#harness-save-json');
    private readonly status = target<HTMLElement>('[data-testid="harness-status"]');
    private readonly downloadCount = target<HTMLElement>('[data-testid="harness-download-count"]');
    private readonly downloadOutput = target<HTMLElement>('[data-testid="harness-download-output"]');
    private readonly log = target<HTMLElement>('[data-testid="harness-log"]');
    private readonly artifactDownload = target<HTMLButtonElement>('#harness-download-file');
    private downloads = 0;

    public mount() {
        target<HTMLElement>('[data-testid="harness-mode"]').textContent = resolveMode();
        target<HTMLElement>('[data-testid="harness-conversation-id"]').textContent = HARNESS_CONVERSATION_ID;
        this.saveButton.addEventListener('click', () => {
            void this.saveJson();
        });
        this.artifactDownload.addEventListener('click', () => {
            simulateChatGPTArtifactDownload(document);
            this.writeLog(
                this.saveButton.isConnected
                    ? 'Download review-ledger.json replaced the page host; Save JSON remained connected.'
                    : 'Download review-ledger.json removed Save JSON unexpectedly.',
            );
        });
        this.writeStatus('Ready for an explicit Save JSON click.');
    }

    private async saveJson() {
        if (this.saveButton.disabled) {
            return;
        }

        this.saveButton.disabled = true;
        this.writeStatus('Saving terminal conversation…');
        try {
            const result = await performSingleExport(undefined, {
                resolveAdapter: () => this.adapter,
                getPageUrl: () => window.location.href,
                getAuthHeaders: () => ({ authorization: 'Bearer harness-test-token' }),
                fetchImpl: fetch,
                downloadJson: (jsonString, filename) => this.downloadJson(jsonString, filename),
            });

            if (result.kind === 'success') {
                this.writeStatus('Saved terminal conversation');
                this.writeLog(`Saved ${result.data.conversation_id} as ${result.filename}.json`);
            } else {
                this.writeStatus(`Failed: ${result.error.kind}`);
                this.writeLog(`Save failed with ${result.error.kind}`);
            }
        } catch (error) {
            this.writeStatus('Failed: unexpected_error');
            this.writeLog(error instanceof Error ? error.message : String(error));
        } finally {
            this.saveButton.disabled = false;
        }
    }

    private downloadJson(jsonString: string, filename: string) {
        const blobUrl = URL.createObjectURL(new Blob([jsonString], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = `${filename}.json`;
        anchor.click();
        URL.revokeObjectURL(blobUrl);

        this.downloads += 1;
        this.downloadCount.textContent = String(this.downloads);
        this.downloadOutput.textContent = jsonString;
    }

    private writeStatus(message: string) {
        this.status.textContent = message;
    }

    private writeLog(message: string) {
        const line = document.createElement('div');
        line.textContent = message;
        this.log.prepend(line);
    }
}

new BrowserHarness().mount();
