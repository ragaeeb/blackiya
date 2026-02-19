import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { Window } from 'happy-dom';

mock.module('@/utils/logger', () => ({
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) },
}));

describe('Gemini — DOM title fallback', () => {
    let geminiAdapter: any;

    beforeAll(async () => {
        const module = await import('@/platforms/gemini');
        geminiAdapter = module.geminiAdapter;
    });

    const withDocument = (doc: any, fn: () => void) => {
        const orig = (globalThis as any).document;
        (globalThis as any).document = doc;
        try {
            fn();
        } finally {
            (globalThis as any).document = orig;
        }
    };

    const withDocumentAndWindow = (doc: any, win: any, fn: () => void) => {
        const origDoc = (globalThis as any).document;
        const origWin = (globalThis as any).window;
        (globalThis as any).document = doc;
        (globalThis as any).window = win;
        try {
            fn();
        } finally {
            (globalThis as any).document = origDoc;
            (globalThis as any).window = origWin;
        }
    };

    it('should extract active conversation title from DOM heading when document title is generic', () => {
        const win = new Window();
        const doc = win.document;
        doc.title = 'Google Gemini';
        doc.body.innerHTML = `<main><h1>Discussion on Quranic Verse Meanings</h1></main>`;

        withDocument(doc, () => {
            expect(geminiAdapter.extractTitleFromDom()).toBe('Discussion on Quranic Verse Meanings');
        });
    });

    it('should return null when document title and DOM heading are both generic', () => {
        const win = new Window();
        const doc = win.document;
        doc.title = 'Google Gemini';
        doc.body.innerHTML = `<main><h1>Google Gemini</h1></main>`;

        withDocument(doc, () => {
            expect(geminiAdapter.extractTitleFromDom()).toBeNull();
        });
    });

    it('should treat "Conversation with Gemini" as generic and fall back to heading title', () => {
        const win = new Window();
        const doc = win.document;
        doc.title = 'Conversation with Gemini';
        doc.body.innerHTML = `<main><h1>Vessels of Gold and Silver</h1></main>`;

        withDocument(doc, () => {
            expect(geminiAdapter.extractTitleFromDom()).toBe('Vessels of Gold and Silver');
        });
    });

    it('should treat "You said ..." as generic and fall back to heading title', () => {
        const win = new Window();
        const doc = win.document;
        doc.title = 'You said ROLE: Expert academic translator';
        doc.body.innerHTML = `<main><h1>Discussion on Istinja Rulings</h1></main>`;

        withDocument(doc, () => {
            expect(geminiAdapter.extractTitleFromDom()).toBe('Discussion on Istinja Rulings');
        });
    });

    it('should extract active sidebar title via aria-current when heading is unavailable', () => {
        const win = new Window();
        const doc = win.document;
        doc.title = 'You said ROLE: Expert academic translator';
        doc.body.innerHTML = `
            <nav><a aria-current="page">Discussion on Istinja' Rulings</a></nav>
            <main><div>No heading yet</div></main>
        `;

        withDocument(doc, () => {
            expect(geminiAdapter.extractTitleFromDom()).toBe("Discussion on Istinja' Rulings");
        });
    });

    it('should extract sidebar title by matching app href to current location when aria-current is absent', () => {
        const win = new Window();
        const doc = win.document;
        doc.title = 'Google Gemini';
        doc.body.innerHTML = `
            <nav>
                <a href="/app/aaaaaaaaaaaaaaaa">Old conversation</a>
                <a href="/app/20de061ec5dae81c">Discussion on Istinja' Rulings</a>
            </nav>
            <main><div>No heading yet</div></main>
        `;
        win.location.href = 'https://gemini.google.com/app/20de061ec5dae81c';

        withDocumentAndWindow(doc, win, () => {
            expect(geminiAdapter.extractTitleFromDom()).toBe("Discussion on Istinja' Rulings");
        });
    });

    it('should ignore sidebar titles whose app href does not match the current conversation', () => {
        const win = new Window();
        const doc = win.document;
        doc.title = 'Google Gemini';
        doc.body.innerHTML = `
            <nav><a href="/app/aaaaaaaaaaaaaaaa">Older conversation title</a></nav>
            <main><div>No heading yet</div></main>
        `;
        win.location.href = 'https://gemini.google.com/app/bbbbbbbbbbbbbbbb';

        withDocumentAndWindow(doc, win, () => {
            expect(geminiAdapter.extractTitleFromDom()).toBeNull();
        });
    });

    it('should ignore sidebar navigation labels such as "Chats"', () => {
        const win = new Window();
        const doc = win.document;
        doc.title = 'Google Gemini';
        doc.body.innerHTML = `
            <nav><button aria-selected="true">Chats</button></nav>
            <main><div>No heading yet</div></main>
        `;

        withDocument(doc, () => {
            expect(geminiAdapter.extractTitleFromDom()).toBeNull();
        });
    });
});
