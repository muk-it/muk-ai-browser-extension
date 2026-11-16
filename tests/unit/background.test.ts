import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Checkpoint, DEFAULT_CHECKPOINT } from '../../lib/checkpoint';
import type { RuntimeMessage, Status } from '../../lib/messaging';

const store = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

const fake = vi.hoisted(() => {
    /**
     * Build an extension event that records its listeners.
     *
     * @returns The event.
     */
    function event() {
        const listeners: ((...args: never[]) => unknown)[] = [];
        return {
            listeners,
            addListener: (fn: (...args: never[]) => unknown) => listeners.push(fn),
        };
    }
    const events = {
        onMessage: event(),
        onConnect: event(),
    };
    const tabs = new Map<number, Partial<chrome.tabs.Tab>>();
    return {
        events,
        tabs,
        create: vi.fn(async ({ url }: { url: string }) => {
            const tab = { id: 100 + tabs.size, url };
            tabs.set(tab.id, tab);
            return tab;
        }),
        update: vi.fn(async (id: number, props: object) =>
            Object.assign(tabs.get(id) ?? {}, props),
        ),
        remove: vi.fn(async (id: number) => tabs.delete(id)),
        openOptionsPage: vi.fn(),
    };
});

vi.mock('../../lib/storage', () => ({
    getCheckpoint: async () => ({ ...store.value }),
    patchCheckpoint: async (patch: object) => {
        store.value = { ...store.value, ...patch };
        return { ...store.value };
    },
}));

vi.mock('wxt/browser', () => {
    const idle = () => ({ addListener: () => undefined });
    return {
        browser: {
            sidePanel: { setPanelBehavior: async () => undefined },
            action: {
                setBadgeBackgroundColor: async () => undefined,
                setBadgeText: async () => undefined,
            },
            scripting: { getRegisteredContentScripts: async () => [] },
            permissions: {
                contains: async () => false,
                onAdded: idle(),
                onRemoved: idle(),
            },
            alarms: {
                onAlarm: idle(),
                clear: async () => true,
                get: async () => undefined,
                create: async () => undefined,
            },
            runtime: {
                onInstalled: idle(),
                onMessage: fake.events.onMessage,
                onConnect: fake.events.onConnect,
                openOptionsPage: fake.openOptionsPage,
            },
            tabs: {
                onRemoved: idle(),
                onActivated: idle(),
                onUpdated: idle(),
                get: async (id: number) => {
                    const tab = fake.tabs.get(id);
                    if (!tab) {
                        throw new Error(`No tab with id: ${id}.`);
                    }
                    return tab;
                },
                query: async () => [],
                create: fake.create,
                update: fake.update,
                remove: fake.remove,
            },
        },
    };
});

const { default: background } = await import('../../entrypoints/background');

const ODOO = 'https://odoo.example';

const APP_MISSING =
    'The MuK AI Browser app is not installed in this Odoo. Install it from Apps, ' +
    'then try again.';

/** Requests the fake Odoo received. */
let requests: { path: string; auth: string | null; body: unknown }[];

/** Answers of the fake Odoo by path; every other path answers `{}`. */
let routes: Record<string, () => Response>;

/**
 * Send a one-off runtime message to the worker and wait for its reply.
 *
 * @param message - The message.
 * @param sender - Its sender.
 * @returns The reply.
 */
function send(
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender = {},
): Promise<unknown> {
    return new Promise((resolve) => {
        const [listener] = fake.events.onMessage.listeners as ((
            message: unknown,
            sender: chrome.runtime.MessageSender,
            reply: (value: unknown) => void,
        ) => boolean)[];
        expect(listener(message, sender, resolve)).toBe(true);
    });
}

/**
 * Read the status the options page shows.
 *
 * @returns The status.
 */
function status(): Promise<Status> {
    return send({ type: 'options/status' }) as Promise<Status>;
}

/**
 * Build a JSON response.
 *
 * @param body - The JSON body.
 * @param status - HTTP status.
 * @returns The response.
 */
function json(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

/**
 * Start the worker with a checkpoint and let its first poll run.
 *
 * @param checkpoint - Fields over a paired checkpoint.
 */
async function start(checkpoint: Partial<Checkpoint> = {}): Promise<void> {
    store.value = {
        ...DEFAULT_CHECKPOINT,
        odooUrl: ODOO,
        apiKey: 'k-1',
        user: { id: 2, name: 'Mitchell Admin' },
        ...checkpoint,
    };
    background.main();
    await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fake.events.onMessage.listeners.length = 0;
    fake.events.onConnect.listeners.length = 0;
    fake.tabs.clear();
    vi.clearAllMocks();
    requests = [];
    routes = {};
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit = {}) => {
            const { pathname } = new URL(url);
            const headers = (init.headers ?? {}) as Record<string, string>;
            requests.push({
                path: pathname,
                auth: headers.Authorization ?? null,
                body: init.body ? JSON.parse(String(init.body)) : null,
            });
            return routes[pathname]?.() ?? json({});
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('background pairing', () => {
    it.each([
        'https://evil.example/muk_ai_browser/connect',
        'https://odoo.example.evil.example/muk_ai_browser/connect',
        `${ODOO}/web#action=muk_ai_browser/connect`,
    ])('refuses a pairing code read on %s', async (url) => {
        await start({ apiKey: null, user: null });
        expect(await send({ type: 'pairing/code', code: 'c-1' }, { url })).toEqual({
            ok: false,
            error: 'This page is not the configured Odoo.',
        });
        expect(requests.map((request) => request.path)).not.toContain(
            '/muk_ai_browser/pair',
        );
        expect(store.value.apiKey).toBeNull();
    });

    it('pairs from the connect page and returns to the tab the user came from', async () => {
        await start({
            apiKey: null,
            user: null,
            connectTabId: 7,
            connectReturnTabId: 3,
        });
        fake.tabs.set(3, { id: 3, url: 'https://shop.example/' });
        routes['/muk_ai_browser/pair'] = () =>
            json({ api_key: 'k-2', user: { id: 2, name: 'Mitchell Admin' } });
        const tab = {
            id: 7,
            url: `${ODOO}/muk_ai_browser/connect?x=1`,
        } as chrome.tabs.Tab;
        expect(await send({ type: 'pairing/code', code: ' c-1 ' }, { tab })).toEqual({
            ok: true,
        });
        expect(requests.at(-1)).toMatchObject({
            path: '/muk_ai_browser/pair',
            auth: null,
            body: { pairing_code: 'c-1' },
        });
        expect(store.value).toMatchObject({ apiKey: 'k-2', connectTabId: null });
        await vi.advanceTimersByTimeAsync(1500);
        expect(fake.update).toHaveBeenCalledWith(3, { active: true });
        expect(fake.remove).toHaveBeenCalledWith(7);
    });
});

describe('background options', () => {
    it('refuses a URL that is not https', async () => {
        await start();
        expect(
            await send({ type: 'options/set-url', url: 'http://odoo.example' }),
        ).toEqual({
            ok: false,
            error: 'Enter an https:// URL (http:// only for localhost).',
        });
        expect(store.value.odooUrl).toBe(ODOO);
    });

    it.each([
        [`${ODOO}/odoo/discuss`, ODOO, true],
        ['other.example', 'https://other.example', false],
    ])('set to %s keeps %s paired: %s', async (url, odooUrl, paired) => {
        await start();
        expect(await send({ type: 'options/set-url', url })).toMatchObject({
            odooUrl,
            paired,
            error: null,
        });
        const unpaired = requests.filter((r) => r.path === '/muk_ai_browser/unpair');
        expect(unpaired).toEqual(
            paired
                ? []
                : [{ path: '/muk_ai_browser/unpair', auth: 'Bearer k-1', body: {} }],
        );
    });

    it('reports an Odoo without the app when its URL is set', async () => {
        await start();
        routes['/ai_browser/chat'] = () => new Response('Not Found', { status: 404 });
        expect(await send({ type: 'options/set-url', url: ODOO })).toMatchObject({
            error: APP_MISSING,
        });
    });

    it.each([
        [404, null, APP_MISSING],
        [303, `${ODOO}/muk_ai_browser/connect`, null],
    ])(
        'connect with /ai_browser/chat answering %s opens %s',
        async (code, url, error) => {
            await start({ apiKey: null, user: null });
            routes['/ai_browser/chat'] = () => new Response('', { status: code });
            await send(
                { type: 'options/connect' },
                { tab: { id: 3 } as chrome.tabs.Tab },
            );
            expect(fake.create.mock.calls).toEqual(url ? [[{ url }]] : []);
            expect(await status()).toMatchObject({ error, connecting: url != null });
            expect(store.value.connectReturnTabId).toBe(url ? 3 : null);
        },
    );

    it('opens the options page to connect while no Odoo is set', async () => {
        await start({ odooUrl: null });
        await send({ type: 'options/connect' });
        expect(fake.openOptionsPage).toHaveBeenCalledOnce();
        expect(fake.create).not.toHaveBeenCalled();
    });
});

describe('background polling', () => {
    const SESSION = { browserSessionId: 'bs-1', aiSessionId: 42 };

    it.each([
        ['polling', '/muk_ai_browser/events'],
        ['attaching again', '/muk_ai_browser/session'],
    ])('forgets a pairing revoked while %s', async (_step, path) => {
        routes['/muk_ai_browser/events'] = () =>
            json({ error: 'browser_session_not_found' }, 404);
        routes[path] = () => json({ error: 'invalid_key' }, 401);
        await start(SESSION);
        expect(store.value).toMatchObject({ apiKey: null, browserSessionId: null });
        expect(await status()).toMatchObject({
            paired: false,
            link: 'idle',
            error: 'The connection to Odoo was revoked. Connect again.',
        });
    });

    it('attaches the chat again when Odoo lost the browser session', async () => {
        routes['/muk_ai_browser/events'] = () =>
            json({ error: 'browser_session_not_found' }, 404);
        routes['/muk_ai_browser/session'] = () =>
            json({ browser_session_id: 'bs-2', ai_session_id: 42 });
        await start(SESSION);
        expect(requests.at(-1)).toMatchObject({
            path: '/muk_ai_browser/session',
            body: { ai_session_id: 42 },
        });
        expect(store.value).toMatchObject({ apiKey: 'k-1', browserSessionId: 'bs-2' });
    });

    it.each([
        [
            'offline',
            () => new Response('<html>Not Found</html>', { status: 404 }),
            APP_MISSING,
        ],
        [
            'unreachable',
            () => {
                throw new TypeError('Failed to fetch');
            },
            'Odoo did not answer.',
        ],
    ])(
        'keeps the pairing and shows the link %s on a failed poll',
        async (link, answer, error) => {
            routes['/muk_ai_browser/events'] = answer;
            await start(SESSION);
            expect(requests.map((request) => request.path)).not.toContain(
                '/muk_ai_browser/session',
            );
            expect(store.value).toMatchObject({ apiKey: 'k-1', ...SESSION });
            expect(await status()).toMatchObject({ paired: true, link, error });
        },
    );
});
