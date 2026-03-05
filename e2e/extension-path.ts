import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_EXTENSION_PATH = path.join(process.cwd(), 'dist', 'chrome-mv3');

const hasManifest = (extensionPath: string) => existsSync(path.join(extensionPath, 'manifest.json'));

export const resolveExtensionPath = () => {
    const envPath = process.env.BLACKIYA_EXTENSION_PATH?.trim();
    if (envPath && hasManifest(envPath)) {
        return {
            extensionPath: envPath,
            valid: true,
            reason: null,
        } as const;
    }

    if (envPath && !hasManifest(envPath)) {
        return {
            extensionPath: envPath,
            valid: false,
            reason: `BLACKIYA_EXTENSION_PATH does not contain manifest.json: ${envPath}`,
        } as const;
    }

    if (hasManifest(DEFAULT_EXTENSION_PATH)) {
        return {
            extensionPath: DEFAULT_EXTENSION_PATH,
            valid: true,
            reason: null,
        } as const;
    }

    return {
        extensionPath: DEFAULT_EXTENSION_PATH,
        valid: false,
        reason: 'Build the extension first (expected manifest at dist/chrome-mv3/manifest.json).',
    } as const;
};
