import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTabs } from '../../lib/runner';

const fake = vi.hoisted(() => {
    const tabs = new Map<number, Partial<chrome.tabs.Tab>>();
    return {
        tabs,
        sendMessage: vi.fn(),
        executeScript: vi.fn(async () => []),
        create: vi.fn(async ({ url }: { url: string }) => {
            const tab = { id: 100 + tabs.size, url, status: 'complete' };
            tabs.set(tab.id, tab);
            return tab;
        }),
        update: vi.fn(async (id: number, props: object) =>
            Object.assign(tabs.get(id) ?? {}, props),
        ),
        remove: vi.fn(async (id: number) => tabs.delete(id)),
    };
});

vi.mock('wxt/browser', () => ({
    browser: {
        tabs: {
            get: async (id: number) => {
                const tab = fake.tabs.get(id);
                if (!tab) {
                    throw new Error(`No tab with id: ${id}.`);
                }
                return tab;
            },
            query: async ({ groupId }: { groupId?: number }) =>
                [...fake.tabs.values()].filter(
                    (tab) => groupId == null || tab.groupId === groupId,
                ),
            group: async ({
                tabIds,
                groupId,
            }: {
                tabIds: number[];
                groupId?: number;
            }) => {
                for (const id of tabIds) {
                    Object.assign(fake.tabs.get(id) ?? {}, { groupId: groupId ?? 8 });
                }
                return groupId ?? 8;
            },
            create: fake.create,
            update: fake.update,
            remove: fake.remove,
            sendMessage: fake.sendMessage,
        },
        tabGroups: { update: async () => undefined },
        scripting: { executeScript: fake.executeScript },
    },
}));

const { runTool } = await import('../../lib/runner');

const PLAN = ['https://shop.example'];

const TARGET = {
    odooUrl: 'https://odoo.example',
    apiKey: 'k-1',
    browserSessionId: 'bs-1',
};

/**
 * Run a tool call, letting the runner's waits for the page elapse.
 *
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @param tabs - Fields over the agent acting in tab 1 of group 8.
 * @returns The outcome.
 */
async function run(
    name: string,
    args: Record<string, unknown>,
    tabs: Partial<AgentTabs> = {},
): ReturnType<typeof runTool> {
    const outcome = runTool(
        { call_id: 'c1', name, arguments: args },
        { tabId: 1, groupId: 8, opened: [], ...tabs },
        PLAN,
        TARGET,
    );
    await vi.advanceTimersByTimeAsync(1000);
    return outcome;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    fake.tabs.clear();
    for (const [id, url] of [
        [1, 'https://shop.example/cart'],
        [2, 'https://evil.example/'],
        [3, 'https://shop.example/opened'],
    ] as const) {
        fake.tabs.set(id, {
            id,
            url,
            title: `Tab ${id}`,
            groupId: 8,
            status: 'complete',
        });
    }
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('runTool', () => {
    it.each([
        ['read_page', {}, {}, 'unknown_tool'],
        ['browser_click', { ref: 'e1' }, { tabId: 9 }, 'no_tab'],
        ['browser_click', { ref: 'e1' }, { tabId: 2 }, 'out_of_plan'],
        ['browser_navigate', { url: 'javascript:alert(1)' }, {}, 'bad_url'],
        [
            'browser_navigate',
            { url: 'file:///etc/passwd', new_tab: true },
            {},
            'bad_url',
        ],
        ['browser_tabs', { action: 'close', tab_id: 1 }, {}, 'not_agent_tab'],
        ['browser_tabs', { action: 'close', tab_id: 9 }, {}, 'unknown_tab'],
        ['browser_save_file', { url: 'file:///etc/passwd' }, {}, 'bad_url'],
    ])('refuses %s %o in %o with %s', async (name, args, tabs, error) => {
        const { result } = await run(name, args, tabs);
        expect(result).toMatchObject({ ok: false, error });
        expect(fake.sendMessage).not.toHaveBeenCalled();
        expect(fake.create).not.toHaveBeenCalled();
        expect(fake.update).not.toHaveBeenCalled();
        expect(fake.remove).not.toHaveBeenCalled();
    });

    it('closes a tab the agent opened and moves to another of its tabs', async () => {
        const { result, tabs } = await run(
            'browser_tabs',
            { action: 'close' },
            { tabId: 3, opened: [3] },
        );
        expect(fake.remove).toHaveBeenCalledWith(3);
        expect(tabs).toEqual({ tabId: 1, groupId: 8, opened: [] });
        expect(result).toEqual({
            ok: true,
            tabs: [
                {
                    tab_id: 1,
                    title: 'Tab 1',
                    url: 'https://shop.example/cart',
                    current: true,
                },
                {
                    tab_id: 2,
                    title: 'Tab 2',
                    url: 'https://evil.example/',
                    current: false,
                },
            ],
        });
    });

    it.each([
        [
            'no listener',
            () =>
                Promise.reject(
                    new Error(
                        'Could not establish connection. Receiving end does not exist.',
                    ),
                ),
        ],
        ['only the launcher', () => Promise.resolve(undefined)],
    ])(
        'injects the content script when %s answers in the tab',
        async (_label, first) => {
            fake.sendMessage
                .mockImplementationOnce(first)
                .mockResolvedValueOnce({ ok: true, matches: [] });
            const { result, origin } = await run('browser_find', { query: 'Pay' });
            expect(fake.executeScript).toHaveBeenCalledWith({
                target: { tabId: 1 },
                files: ['/content-scripts/content.js'],
            });
            expect(fake.sendMessage).toHaveBeenCalledTimes(2);
            expect(result).toEqual({ ok: true, matches: [] });
            expect(origin).toBe('https://shop.example');
        },
    );

    it.each([
        [
            'browser_click',
            {
                ok: true,
                url: 'https://shop.example/cart',
                title: 'Tab 1',
                snapshot: '- heading "Paid"',
            },
        ],
        [
            'browser_read_page',
            {
                ok: false,
                error: 'page_changed',
                message: 'The page changed meanwhile: read it again.',
            },
        ],
    ])(
        'answers %s on a page that unloaded meanwhile without running it again',
        async (name, expected) => {
            fake.sendMessage
                .mockRejectedValueOnce(
                    new Error(
                        'A listener indicated an asynchronous response by returning true, ' +
                            'but the message channel closed before a response was received',
                    ),
                )
                .mockResolvedValue({ ok: true, snapshot: '- heading "Paid"' });
            const { result } = await run(name, { ref: 'e1' });
            expect(result).toEqual(expected);
            expect(fake.executeScript).not.toHaveBeenCalled();
            expect(
                fake.sendMessage.mock.calls.map(([, message]) => message.name),
            ).toEqual(name === 'browser_click' ? [name, 'browser_read_page'] : [name]);
        },
    );
});

describe('runTool across tabs', () => {
    it.each([
        [3, { ok: true, snapshot: '- heading "Opened"', tab_id: 3 }, [3]],
        [4, { ok: false, error: 'unknown_tab' }, []],
    ])('reads tab %s without switching to it', async (tabId, expected, readIn) => {
        fake.tabs.set(4, { id: 4, url: 'https://bank.example/', status: 'complete' });
        fake.sendMessage.mockResolvedValue({
            ok: true,
            snapshot: '- heading "Opened"',
        });
        const { result, tabs } = await run('browser_read_page', { tab_id: tabId });
        expect(result).toMatchObject(expected);
        expect(tabs.tabId).toBe(1);
        expect(fake.sendMessage.mock.calls.map(([id]) => id)).toEqual(readIn);
        expect(fake.update).not.toHaveBeenCalled();
    });
});

describe('runTool files', () => {
    /** Requests the stubbed fetch received. */
    let fetched: { url: string; init: RequestInit }[];

    /**
     * Stub `fetch` with one response.
     *
     * @param body - The response body.
     * @param init - Status and headers.
     */
    function respond(body: string, init: ResponseInit = {}): void {
        fetched = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, request: RequestInit) => {
                fetched.push({ url, init: request });
                return new Response(body, init);
            }),
        );
    }

    it.each([
        [
            { ref: 'e4' },
            'https://shop.example/files/offer.pdf',
            "attachment; filename*=UTF-8''Offer%202026.pdf",
            'Offer 2026.pdf',
        ],
        [
            { url: 'https://cdn.example/scans/scan%201.pdf', name: 'Scan.pdf' },
            'https://cdn.example/scans/scan%201.pdf',
            'attachment; filename="other.pdf"',
            'Scan.pdf',
        ],
        [
            { url: 'https://cdn.example/scans/scan%201.pdf' },
            'https://cdn.example/scans/scan%201.pdf',
            '',
            'scan 1.pdf',
        ],
        [{}, 'https://shop.example/cart', 'inline; filename="cart.pdf"', 'cart.pdf'],
    ])(
        'saves the file of %o with the site cookies',
        async (args, url, disposition, name) => {
            respond('%PDF', {
                headers: {
                    'Content-Type': 'application/pdf; qs=0.9',
                    'Content-Disposition': disposition,
                },
            });
            fake.sendMessage.mockResolvedValue({ ok: true, url });
            const { result } = await run('browser_save_file', args);
            expect(fetched).toEqual([{ url, init: { credentials: 'include' } }]);
            expect(fake.sendMessage.mock.calls.map(([, message]) => message)).toEqual(
                'ref' in args
                    ? [
                          {
                              type: 'content/tool',
                              name: '_link',
                              arguments: { ref: 'e4' },
                          },
                      ]
                    : [],
            );
            expect(result).toEqual({
                ok: true,
                file: { name, mimetype: 'application/pdf', data: btoa('%PDF') },
            });
        },
    );

    it.each([
        [{ status: 403 }, '', 'fetch_failed'],
        [
            { headers: { 'Content-Length': String(21 * 1024 * 1024) } },
            '',
            'file_too_large',
        ],
        [{}, 'x'.repeat(20 * 1024 * 1024 + 1), 'file_too_large'],
    ])('refuses to save a file answered with %o', async (init, body, error) => {
        respond(body, init);
        const { result } = await run('browser_save_file', {
            url: 'https://cdn.example/big.pdf',
        });
        expect(result).toMatchObject({ ok: false, error });
    });

    it('uploads the Odoo file of the call into a field of the tab', async () => {
        respond('%PDF', {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': 'attachment; filename="offer.pdf"',
            },
        });
        fake.sendMessage.mockResolvedValue({ ok: true, snapshot: '- button "Send"' });
        const { result } = await run('browser_upload_file', {
            ref: 'e5',
            element: 'Attachment',
            attachment_id: 7,
        });
        expect(fetched).toEqual([
            {
                url: 'https://odoo.example/muk_ai_browser/file?browser_session_id=bs-1&call_id=c1',
                init: expect.objectContaining({
                    headers: expect.objectContaining({ Authorization: 'Bearer k-1' }),
                    credentials: 'omit',
                }),
            },
        ]);
        expect(fake.sendMessage.mock.calls).toEqual([
            [
                1,
                {
                    type: 'content/tool',
                    name: '_upload',
                    arguments: {
                        ref: 'e5',
                        name: 'offer.pdf',
                        mimetype: 'application/pdf',
                        data: btoa('%PDF'),
                    },
                },
            ],
        ]);
        expect(result).toEqual({ ok: true, snapshot: '- button "Send"' });
    });
});
