import { classifyStreamDebugFrame, type StreamDebugRecorder } from '@/features/stream-debug/recorder';
import { createStreamFrameAssembler, type StreamFraming } from '@/features/stream-debug/stream-monitor';

export type XhrStreamCaptureOptions = {
    streamId: string;
    recorder: StreamDebugRecorder;
    framing?: StreamFraming;
    readResponseText: () => string;
};

export const createXhrStreamCapture = ({
    streamId,
    recorder,
    framing = 'raw',
    readResponseText,
}: XhrStreamCaptureOptions) => {
    const assembler = createStreamFrameAssembler(framing);
    let previousResponseLength = 0;
    let previousResponseTail = '';
    let settled = false;

    const appendText = (text: string) => {
        for (const frame of assembler.push(text)) {
            const classification = classifyStreamDebugFrame(frame);
            recorder.appendFrame(streamId, frame, {
                kind: classification.kind ?? (framing === 'sse' ? 'sse_event' : 'data'),
                ...(classification.event ? { event: classification.event } : {}),
            });
        }
    };

    const flush = () => {
        for (const frame of assembler.flush()) {
            recorder.appendFrame(streamId, frame);
        }
    };

    const readProgress = (): boolean => {
        try {
            const responseText = readResponseText();
            if (typeof responseText !== 'string') {
                return false;
            }
            const previousTailStart = Math.max(0, previousResponseLength - previousResponseTail.length);
            const continuesPreviousBody =
                responseText.length >= previousResponseLength &&
                responseText.slice(previousTailStart, previousResponseLength) === previousResponseTail;
            const delta = continuesPreviousBody ? responseText.slice(previousResponseLength) : responseText;
            previousResponseLength = responseText.length;
            previousResponseTail = responseText.slice(-256);
            appendText(delta);
            return true;
        } catch {
            return false;
        }
    };

    const settle = (event: 'close' | 'abort' | 'error') => {
        if (settled) {
            return;
        }
        settled = true;
        readProgress();
        flush();
        recorder.terminateStream(streamId, event);
    };

    return {
        progress: () => {
            readProgress();
        },
        load: () => {
            readProgress();
            flush();
        },
        loadEnd: () => {
            settle('close');
        },
        abort: () => {
            settle('abort');
        },
        error: () => {
            settle('error');
        },
    };
};
