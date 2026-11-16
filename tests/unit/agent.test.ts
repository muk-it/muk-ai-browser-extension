import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Checkpoint, DEFAULT_CHECKPOINT } from '../../lib/checkpoint';

const store = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const runTool = vi.hoisted(() => vi.fn());

vi.mock('../../lib/storage', () => ({
    getCheckpoint: async () => ({ ...store.value }),
    patchCheckpoint: async (patch: object) => {
        store.value = { ...store.value, ...patch };
        return { ...store.value };
    },
}));

vi.mock('../../lib/runner', () => ({
    runTool,
    agentTabs: async () => [
        { id: 3, url: 'https://shop.example/cart' },
        { id: 5, url: 'chrome://newtab/' },
    ],
    tabOrigin: async (tabId: number | null) =>
        ({ 3: 'https://shop.example', 5: 'https://other.example' })[tabId ?? 0] ?? null,
}));

const { RESULT_LOST, attach, pollOnce } = await import('../../lib/agent');

/** Requests the fake Odoo received. */
let requests: { path: string; query: URLSearchParams; body: unknown }[];

/** Actions the fake Odoo hands out on every poll. */
let pending: { call_id: string; name: string; arguments: object }[];

beforeEach(() => {
    requests = [];
    pending = [{ call_id: 'c1', name: 'browser_click', arguments: { ref: 'e2' } }];
    store.value = {
        ...DEFAULT_CHECKPOINT,
        odooUrl: 'https://odoo.example',
        apiKey: 'k-1',
        agentTabId: 3,
    } satisfies Checkpoint;
    runTool.mockReset().mockResolvedValue({
        result: { ok: true, snapshot: '- button "Pay"' },
        tabs: { tabId: 4, groupId: 8, opened: [4] },
        origin: 'https://pay.example',
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
            const parsed = new URL(url);
            const path = parsed.pathname.replace('/muk_ai_browser/', '');
            requests.push({
                path,
                query: parsed.searchParams,
                body: init.body ? JSON.parse(String(init.body)) : null,
            });
            const body =
                path === 'session'
                    ? { browser_session_id: 'bs-1', ai_session_id: 42 }
                    : path === 'events'
                      ? {
                            state: 'running',
                            actions: pending,
                            plan_origins: ['https://pay.example'],
                            retry_ms: 1000,
                        }
                      : {};
            return new Response(JSON.stringify(body));
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('agent', () => {
    it('attaches, polls with the tab origin, runs the action once and posts it', async () => {
        await attach(42, 'Chrome on win');
        expect(requests[0]).toMatchObject({
            path: 'session',
            body: {
                ai_session_id: 42,
                device_label: 'Chrome on win',
                origin: 'https://shop.example',
            },
        });
        expect(store.value).toMatchObject({
            browserSessionId: 'bs-1',
            aiSessionId: 42,
        });

        const response = await pollOnce();
        expect(response.state).toBe('running');
        expect(requests[1].path).toBe('events');
        expect(Object.fromEntries(requests[1].query)).toEqual({
            browser_session_id: 'bs-1',
            origin: 'https://shop.example',
            tabs: '[{"id":3,"origin":"https://shop.example"},{"id":5,"origin":""}]',
        });
        expect(runTool.mock.calls).toEqual([
            [
                pending[0],
                { tabId: 3, groupId: null, opened: [] },
                ['https://pay.example'],
                expect.objectContaining({ apiKey: 'k-1', browserSessionId: 'bs-1' }),
            ],
        ]);
        expect(requests[2]).toEqual({
            path: 'result',
            query: new URLSearchParams(),
            body: {
                browser_session_id: 'bs-1',
                call_id: 'c1',
                origin: 'https://pay.example',
                result: { ok: true, snapshot: '- button "Pay"' },
            },
        });
        expect(store.value).toMatchObject({
            agentTabId: 4,
            agentGroupId: 8,
            agentOpenedTabIds: [4],
            executed: ['c1'],
        });

        await pollOnce();
        expect(runTool).toHaveBeenCalledOnce();
        expect(requests.at(-1)?.body).toMatchObject({
            call_id: 'c1',
            result: RESULT_LOST,
        });
    });

    it.each([
        ['browser_click', {}, 'HTTPS://Shop.Example', true],
        ['browser_click', {}, 'https://evil.example', false],
        ['browser_navigate', {}, undefined, true],
        ['browser_read_page', { tab_id: 5 }, 'https://other.example', true],
        ['browser_read_page', { tab_id: 5 }, 'https://shop.example', false],
    ])('%s %o judged on %s runs: %s', async (name, args, origin, runs) => {
        store.value = { ...store.value, browserSessionId: 'bs-1' };
        pending = [{ call_id: 'c1', name, arguments: args, ...(origin && { origin }) }];
        await pollOnce();
        expect(runTool).toHaveBeenCalledTimes(runs ? 1 : 0);
        expect(store.value.executed).toEqual(runs ? ['c1'] : []);
        if (!runs) {
            expect(requests.at(-1)?.body).toEqual({
                browser_session_id: 'bs-1',
                call_id: 'c1',
                origin: 'https://shop.example',
                result: {
                    ok: false,
                    error: 'origin_changed',
                    message:
                        `The tab moved to ${'tab_id' in args ? 'https://other.example' : 'https://shop.example'} ` +
                        'before this action ran; read the page again.',
                },
            });
        }
    });

    it('does not attach while unpaired', async () => {
        store.value = { ...store.value, apiKey: null };
        await attach(42, 'Chrome on win');
        expect(requests).toEqual([]);
    });
});
