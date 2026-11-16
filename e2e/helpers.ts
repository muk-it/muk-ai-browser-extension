import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';

/**
 * Shared e2e plumbing: a copy of the built extension with "all sites" already
 * granted (Playwright cannot click Chrome's permission prompt), a persistent
 * Chromium context that loads it, and a throwaway HTTP server.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The production build (`npm run build`). */
export const BUILD = path.resolve(__dirname, '../.output/chrome-mv3');

/** The fixture page the tools act on. */
export const FIXTURE = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'page.html'),
    'utf8',
);

/** A launched browser with the extension. */
export interface Launched {
    context: BrowserContext;
    worker: Worker;
    extensionId: string;
    close: () => Promise<void>;
}

/**
 * Copy the build and grant `<all_urls>` in its manifest, standing in for the
 * user's "Allow on all sites" click.
 *
 * @returns The path of the granted copy.
 */
function grantedCopy(): string {
    if (!fs.existsSync(BUILD)) {
        throw new Error(`No build at ${BUILD}. Run \`npm run build\` first.`);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muk-ai-ext-'));
    fs.cpSync(BUILD, dir, { recursive: true });
    const file = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.host_permissions = ['<all_urls>'];
    fs.writeFileSync(file, JSON.stringify(manifest));
    return dir;
}

/**
 * Launch Chromium with the granted extension copy, headless unless `HEADED`
 * is set.
 *
 * @returns The context, the service worker and a cleanup function.
 */
export async function launch(): Promise<Launched> {
    const extension = grantedCopy();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'muk-ai-profile-'));
    const context = await chromium.launchPersistentContext(profile, {
        headless: false,
        args: [
            ...(process.env.HEADED ? [] : ['--headless=new']),
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
        ],
    });
    const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
    return {
        context,
        worker,
        extensionId: new URL(worker.url()).host,
        close: async () => {
            await context.close();
            fs.rmSync(profile, { recursive: true, force: true });
            fs.rmSync(extension, { recursive: true, force: true });
        },
    };
}

/** A running HTTP server. */
export interface Served {
    origin: string;
    close: () => Promise<void>;
}

/**
 * Serve requests on a free localhost port.
 *
 * @param handler - The request handler.
 * @returns The server origin and a cleanup function.
 */
export async function serve(handler: http.RequestListener): Promise<Served> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
        origin: `http://localhost:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}

/**
 * Read a request's JSON body.
 *
 * @param req - The request.
 * @returns The decoded body, or `{}`.
 */
export async function jsonBody(
    req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
    let text = '';
    for await (const chunk of req) {
        text += chunk;
    }
    return text ? JSON.parse(text) : {};
}

/**
 * Answer with JSON.
 *
 * @param res - The response.
 * @param body - The body.
 * @param status - The HTTP status.
 */
export function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
