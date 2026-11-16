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
        name,
        args,
        { tabId: 1, groupId: 8, opened: [], ...tabs },
        PLAN,
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

    it('injects the content script when no tool answers in the tab', async () => {
        fake.sendMessage
            .mockRejectedValueOnce(
                new Error(
                    'Could not establish connection. Receiving end does not exist.',
                ),
            )
            .mockResolvedValueOnce({ ok: true, matches: [] });
        const { result, origin } = await run('browser_find', { query: 'Pay' });
        expect(fake.executeScript).toHaveBeenCalledWith({
            target: { tabId: 1 },
            files: ['/content-scripts/content.js'],
        });
        expect(fake.sendMessage).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ ok: true, matches: [] });
        expect(origin).toBe('https://shop.example');
    });

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
