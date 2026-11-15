import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { test, expect, type Page } from '@playwright/test';
import {
    BUILD,
    FIXTURE,
    type Launched,
    type Served,
    jsonBody,
    launch,
    sendJson,
    serve,
} from './helpers';

/**
 * Self-contained e2e of the built extension: its manifest, the content-side
 * tools on a real page, and the whole contract (pairing through the connect
 * page, the embedded chat reporting its id, attaching, polling, running
 * actions, posting results) against a small fake Odoo.
 */

let browser: Launched;
let site: Served;

test.beforeAll(async () => {
    browser = await launch();
    site = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(FIXTURE);
    });
});

test.afterAll(async () => {
    await browser?.close();
    await site?.close();
});

/**
 * Open the fixture page and return its tab id.
 *
 * @returns The page and its tab id.
 */
async function openFixture(): Promise<{ page: Page; tabId: number }> {
    const page = await browser.context.newPage();
    await page.goto(`${site.origin}/`);
    await page.bringToFront();
    const tabId = await browser.worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        return tab.id as number;
    }, `${site.origin}/`);
    return { page, tabId };
}

test('ships without standing host access, localhost or a content script', () => {
    const text = fs.readFileSync(path.join(BUILD, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(text);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    expect(manifest.permissions).toEqual(
        expect.arrayContaining(['sidePanel', 'tabGroups']),
    );
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
    expect(manifest.content_scripts ?? []).toEqual([]);
    expect(manifest.externally_connectable).toBeUndefined();
    for (const file of [
        text,
        fs.readFileSync(path.join(BUILD, 'background.js'), 'utf8'),
    ]) {
        expect(file).not.toContain('localhost:8069');
    }
});

test('content tools read and click, and refuse a password field', async () => {
    const { page, tabId } = await openFixture();
    const call = (name: string, args: Record<string, unknown>) =>
        browser.worker.evaluate(
            async ({ tabId, name, args }) => {
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['content-scripts/content.js'],
                });
                return chrome.tabs.sendMessage(tabId, {
                    type: 'content/tool',
                    name,
                    arguments: args,
                });
            },
            { tabId, name, args },
        );

    const read = await call('browser_read_page', {});
    expect(read.ok).toBe(true);
    const snapshot = String(read.snapshot);
    const ref = (label: string) =>
        new RegExp(`${label}.*\\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];

    const clicked = await call('browser_click', { ref: ref('button "Run Action"') });
    expect(clicked.ok).toBe(true);
    await expect(page.locator('#output p')).toHaveText('ACTION_DONE');
    expect(clicked.snapshot).toContain('ACTION_DONE');

    expect(
        await call('browser_type', { ref: ref('textbox "Name"'), text: 'Jane' }),
    ).toMatchObject({
        ok: true,
    });
    await expect(page.locator('#name')).toHaveValue('Jane');
    expect(
        await call('browser_type', { ref: ref('textbox "Password"'), text: 'x' }),
    ).toMatchObject({ ok: false, error: 'sensitive_field' });
    await expect(page.locator('#pw')).toHaveValue('');
    await page.close();
});

test('pairs, embeds the Odoo chat, attaches to it and runs its actions', async () => {
    test.setTimeout(60_000);
    const { context, extensionId } = browser;
    const odoo = await fakeOdoo(extensionId);
    try {
        const options = await context.newPage();
        await options.goto(`chrome-extension://${extensionId}/options.html`);
        await options.getByLabel('Odoo URL').fill(odoo.served.origin);
        await options.getByRole('button', { name: 'Save' }).click();
        await expect(options.getByText('Not connected')).toBeVisible();
        await expect(options.locator('[aria-current=step] h2')).toHaveText('Connect');

        const panel = await context.newPage();
        await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
        await expect(panel.getByText('Connect to your Odoo')).toBeVisible();

        const connect = await context.newPage();
        await connect.goto(`${odoo.served.origin}/muk_ai_browser/connect`);
        await expect(connect.getByRole('status')).toContainText(
            'This browser is connected to Odoo',
        );
        await expect(connect.locator('pre.mk_browser_code')).toHaveCount(0);
        await expect(
            options.getByText(
                `Connected as Mitchell Admin to ${new URL(odoo.served.origin).host}`,
            ),
        ).toBeVisible();
        await Promise.all([
            connect.waitForEvent('close'),
            connect.getByRole('button', { name: 'Close this tab' }).click(),
        ]);

        await expect(
            panel.getByRole('button', { name: 'Log in to Odoo' }),
        ).toBeVisible();
        await expect(panel.locator('iframe.mk-frame')).toHaveCount(0);
        odoo.loggedIn = true;
        await expect(panel.locator('iframe.mk-frame')).toHaveAttribute(
            'src',
            `${odoo.served.origin}/odoo/ai-chat/`,
        );
        await expect(
            panel.frameLocator('iframe.mk-frame').getByText('Fake muk_ai chat'),
        ).toBeVisible();
        await expect.poll(() => odoo.attached).toMatchObject({ ai_session_id: 9 });

        const { page } = await openFixture();
        await expect(page.locator('#output p')).toHaveText('ACTION_DONE', {
            timeout: 15_000,
        });
        await expect(panel.locator('.mk-agentbar')).toContainText(
            'Acting in localhost',
        );
        await expect(page.locator('#muk-ai-launcher')).toHaveCount(1);
        const chat = await context.newPage();
        await chat.goto(`${odoo.served.origin}/odoo/ai-chat`);
        await expect(chat.getByText('Fake muk_ai chat')).toBeVisible();
        await expect(chat.locator('#muk-ai-launcher')).toHaveCount(0);
        expect(odoo.results.c1).toMatchObject({
            browser_session_id: 'bs-5',
            origin: site.origin,
            result: { ok: true },
        });
        await expect
            .poll(() => odoo.results.c2)
            .toMatchObject({
                origin: site.origin,
                result: { ok: true },
            });
        await expect(panel.getByRole('button', { name: 'Log in to Odoo' })).toHaveCount(
            0,
        );
        await expect(panel.locator('.mk-loading')).toHaveCount(0);

        const loads = odoo.chatLoads;
        odoo.down = true;
        await expect(panel.getByText('Odoo is not reachable')).toBeVisible({
            timeout: 15_000,
        });
        odoo.down = false;
        await expect(panel.getByText('Odoo is not reachable')).toHaveCount(0, {
            timeout: 15_000,
        });
        await expect.poll(() => odoo.chatLoads).toBeGreaterThan(loads);
        await expect(panel.locator('.mk-loading')).toHaveCount(0);
    } finally {
        await odoo.served.close();
    }
});

/** What the fake Odoo recorded, and whether a user is logged in to it. */
interface FakeOdoo {
    served: Served;
    loggedIn: boolean;
    /** Drop every connection, like an Odoo that restarts. */
    down: boolean;
    chatLoads: number;
    attached: Record<string, unknown> | null;
    results: Record<string, Record<string, unknown>>;
}

/**
 * Start a fake Odoo: a login check, a connect page with a pairing code in the
 * markup of Odoo's template, a chat page that shows a login page until the
 * user is logged in and then reports chat 9 to the extension frame, and an
 * agent that reads the page (c1), then clicks "Run Action" (c2) once the
 * extension polls from the fixture site. While `down`, it drops every
 * connection.
 *
 * @param extensionId - The extension allowed to frame the chat.
 * @returns The server and what it recorded.
 */
async function fakeOdoo(extensionId: string): Promise<FakeOdoo> {
    const fake: FakeOdoo = {
        served: null as unknown as Served,
        loggedIn: false,
        down: false,
        chatLoads: 0,
        attached: null,
        results: {},
    };
    const actions: {
        call_id: string;
        name: string;
        arguments: object;
        origin: string;
    }[] = [];
    const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
        if (fake.down) {
            req.socket.destroy();
            return;
        }
        const url = new URL(req.url ?? '/', 'http://x');
        if (url.pathname === '/web/session/get_session_info') {
            sendJson(
                res,
                fake.loggedIn
                    ? { jsonrpc: '2.0', id: null, result: { uid: 2 } }
                    : { jsonrpc: '2.0', id: null, error: { code: 100 } },
            );
            return;
        }
        if (url.pathname.startsWith('/odoo/ai-chat')) {
            fake.chatLoads += 1;
            res.writeHead(200, {
                'Content-Type': 'text/html',
                'Content-Security-Policy': `frame-ancestors chrome-extension://${extensionId}`,
            });
            res.end(
                fake.loggedIn
                    ? '<!doctype html><title>Chat</title><p>Fake muk_ai chat</p><script>' +
                          "parent.postMessage({type: 'muk_ai_browser.chat', id: 9}," +
                          ' location.ancestorOrigins[0]);</script>'
                    : '<!doctype html><title>Login</title><p>Log in</p>',
            );
            return;
        }
        const route = url.pathname.replace('/muk_ai_browser/', '');
        if (route === 'connect') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(
                '<html><head><meta name="muk-ai-browser-pairing" content="CODE-1"></head>' +
                    '<body><div class="card"><div class="card-body">' +
                    '<h1>Connect a Browser</h1><p class="mk_browser_status">Picks it up.</p>' +
                    '<pre class="mk_browser_code">CODE-1</pre></div></div></body></html>',
            );
            return;
        }
        const body = req.method === 'POST' ? await jsonBody(req) : {};
        if (route === 'pair') {
            sendJson(res, {
                api_key: 'key-1',
                scope: 'write',
                device_id: 1,
                user: { id: 2, name: 'Mitchell Admin' },
            });
            return;
        }
        if (req.headers.authorization !== 'Bearer key-1') {
            sendJson(res, { error: 'invalid_key' }, 401);
            return;
        }
        if (route === 'session') {
            fake.attached = body;
            sendJson(res, {
                browser_session_id: 'bs-5',
                ai_session_id: body.ai_session_id,
            });
        } else if (route === 'events') {
            if (!actions.length && url.searchParams.get('origin') === site.origin) {
                actions.push({
                    call_id: 'c1',
                    name: 'browser_read_page',
                    arguments: {},
                    origin: site.origin,
                });
            }
            const open = actions.filter((action) => !fake.results[action.call_id]);
            sendJson(res, {
                state: open.length ? 'waiting' : 'done',
                actions: open,
                plan_origins: [],
                retry_ms: 200,
            });
        } else if (route === 'result') {
            const callId = String(body.call_id);
            if (fake.results[callId]) {
                sendJson(res, { error: 'duplicate' }, 409);
                return;
            }
            fake.results[callId] = body;
            if (callId === 'c1') {
                const result = body.result as { snapshot?: string };
                const ref = /button "Run Action".*\[ref=(e\d+)\]/.exec(
                    result.snapshot ?? '',
                )?.[1];
                actions.push({
                    call_id: 'c2',
                    name: 'browser_click',
                    arguments: { ref },
                    origin: site.origin,
                });
            }
            sendJson(res, {});
        } else {
            sendJson(res, { error: 'not_found' }, 404);
        }
    };
    fake.served = await serve((req, res) => void handler(req, res));
    return fake;
}
