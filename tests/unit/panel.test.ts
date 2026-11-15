import { act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSwMessage, Status } from '../../lib/messaging';

const port = vi.hoisted(() => ({
    sent: [] as unknown[],
    listener: null as ((message: unknown) => void) | null,
}));

/** What the worker answers to `panel/logged-in`, in order (last one repeats). */
const login = vi.hoisted(() => ({ answers: [] as (boolean | null)[] }));

vi.mock('wxt/browser', () => ({
    browser: {
        runtime: {
            connect: () => ({
                onMessage: {
                    addListener: (fn: (message: unknown) => void) => {
                        port.listener = fn;
                    },
                },
                postMessage: (message: unknown) => port.sent.push(message),
                disconnect: () => undefined,
            }),
            sendMessage: async () =>
                login.answers.length > 1 ? login.answers.shift() : login.answers[0],
        },
        windows: { getCurrent: async () => ({ id: 1 }) },
        tabs: { create: vi.fn() },
    },
}));

const { App } = await import('../../entrypoints/sidepanel/App');

const ODOO = 'https://odoo.example';

const STATUS: Status = {
    odooUrl: ODOO,
    paired: true,
    userName: 'Mitchell Admin',
    link: 'online',
    connecting: false,
    error: null,
    agentTab: {
        title: 'Shop',
        url: 'https://shop.example/cart',
        favIconUrl: null,
    },
    groupTabs: 1,
    working: false,
    chatId: 7,
};

let container: HTMLDivElement;
let root: Root;

/**
 * Post a window message as if it came from `source`.
 *
 * @param origin - The sender origin.
 * @param source - The sender window.
 * @param data - The message, by default the open chat 42.
 */
function post(
    origin: string,
    source: Window | null,
    data: object = { type: 'muk_ai_browser.chat', id: 42 },
): void {
    act(() => {
        window.dispatchEvent(new MessageEvent('message', { origin, source, data }));
    });
}

/**
 * Return the frame requests the panel sent to the worker.
 *
 * @returns The `panel/attach` and `panel/show` messages.
 */
function forwarded(): PanelToSwMessage[] {
    return (port.sent as PanelToSwMessage[]).filter(
        (m) => m.type === 'panel/attach' || m.type === 'panel/show',
    );
}

/**
 * Render the panel paired, with the worker answering the login check.
 *
 * @param answers - The login answers, in order.
 */
async function open(...answers: (boolean | null)[]): Promise<void> {
    login.answers = answers;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(App)));
    act(() => port.listener?.({ type: 'sw/status', status: STATUS }));
    await act(() => vi.advanceTimersByTimeAsync(0));
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
        true;
    vi.useFakeTimers();
    port.sent = [];
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
});

describe('side panel', () => {
    it('connects, waits for the login in the tab, then shows the chat', async () => {
        await open(true);
        const show = (status: Partial<Status>) =>
            act(() =>
                port.listener?.({
                    type: 'sw/status',
                    status: { ...STATUS, ...status },
                }),
            );
        show({ paired: false });
        act(() =>
            container.querySelector<HTMLButtonElement>('.mk-btn--primary')?.click(),
        );
        expect(port.sent).toContainEqual({ type: 'panel/connect' });
        expect(container.querySelector('[role=status]')).toBeNull();
        show({ paired: false, connecting: true });
        expect(container.querySelector('.mk-cta__title')?.textContent).toBe(
            'Log in to Odoo in the new tab',
        );
        expect(container.querySelector('[role=status]')?.textContent).toBe(
            'Waiting for the login',
        );
        expect(container.querySelector('.mk-btn--primary')).toBeNull();
        show({});
        expect(container.querySelector('.mk-cta')).toBeNull();
        expect(container.querySelector('iframe')).not.toBeNull();
    });

    it('opens a new chat with the agent bar above it', async () => {
        await open(true);
        expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
            `${ODOO}/ai_browser/chat`,
        );
        expect(container.querySelector('iframe')?.hasAttribute('sandbox')).toBe(false);
        expect(container.querySelector('.mk-agentbar')?.textContent).toBe(
            'Acting in shop.example',
        );
        expect(container.querySelector('.mk-agentbar__dot')).toBeNull();
        act(() =>
            port.listener?.({
                type: 'sw/status',
                status: { ...STATUS, working: true, groupTabs: 3 },
            }),
        );
        expect(container.querySelector('.mk-agentbar__dot')).not.toBeNull();
        expect(container.querySelector('.mk-agentbar')?.textContent).toBe(
            'Acting in shop.example · 3 tabs',
        );
    });

    it('forwards only what the Odoo frame reports', async () => {
        await open(true);
        const frame = container.querySelector('iframe')?.contentWindow ?? null;
        const show = { type: 'muk_ai_browser.show', path: '/odoo/product.template/7' };
        expect(frame).not.toBeNull();
        post('https://evil.example', frame);
        post(ODOO, window);
        post('https://evil.example', frame, show);
        post(ODOO, frame, { ...show, path: 'https://evil.example/odoo/x' });
        expect(forwarded()).toEqual([]);
        post(ODOO, frame);
        post(ODOO, frame, show);
        expect(forwarded()).toEqual([
            { type: 'panel/attach', chatId: 42 },
            { type: 'panel/show', path: '/odoo/product.template/7' },
        ]);
    });

    it('shows a loading state until the chat opens, and a retry when slow', async () => {
        await open(true);
        expect(container.textContent).toContain('Opening your chat...');
        await act(() => vi.advanceTimersByTimeAsync(44_999));
        expect(container.textContent).not.toContain('Still loading');
        await act(() => vi.advanceTimersByTimeAsync(1));
        expect(container.textContent).toContain('Still loading...');
        expect(container.textContent).not.toContain('Log in');
        post(ODOO, container.querySelector('iframe')?.contentWindow ?? null);
        expect(container.querySelector('[role=status]')).toBeNull();
    });

    it.each([
        [false, 'Log in to Odoo', [3_000, 3_000]],
        [null, 'Odoo is not reachable', [2_000, 4_000]],
    ])(
        'answers %s with "%s" at once and opens the chat once Odoo has a user',
        async (answer, notice, waits) => {
            await open(answer, answer, true);
            expect(container.textContent).toContain(notice);
            expect(container.textContent).not.toContain('Opening your chat');
            expect(container.querySelector('iframe')).toBeNull();
            await act(() => vi.advanceTimersByTimeAsync(waits[0]));
            expect(container.textContent).toContain(notice);
            await act(() => vi.advanceTimersByTimeAsync(waits[1]));
            expect(container.textContent).not.toContain(notice);
            expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
                `${ODOO}/ai_browser/chat`,
            );
        },
    );

    it('covers the chat while Odoo is unreachable and reloads it after', async () => {
        await open(true);
        const first = container.querySelector('iframe');
        post(ODOO, first?.contentWindow ?? null);
        const status = (link: Status['link']) =>
            act(() =>
                port.listener?.({ type: 'sw/status', status: { ...STATUS, link } }),
            );
        status('unreachable');
        expect(container.textContent).toContain('Odoo is not reachable');
        expect(container.querySelector('iframe')).toBe(first);
        status('online');
        expect(container.textContent).not.toContain('Odoo is not reachable');
        expect(container.textContent).toContain('Opening your chat...');
        expect(container.querySelector('iframe')).not.toBe(first);
        expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
            `${ODOO}/ai_browser/chat/7`,
        );
    });

    it('asks the worker to poll at once when the panel shows again', async () => {
        await open(true);
        port.sent = [];
        document.dispatchEvent(new Event('visibilitychange'));
        await act(() => vi.advanceTimersByTimeAsync(0));
        expect(port.sent).toEqual([{ type: 'panel/open', windowId: 1 }]);
    });

    it('checks Odoo again when the loaded frame stays silent', async () => {
        await open(true, null);
        act(() => {
            container.querySelector('iframe')?.dispatchEvent(new Event('load'));
        });
        await act(() => vi.advanceTimersByTimeAsync(3_000));
        expect(container.textContent).toContain('Odoo is not reachable');
        expect(container.textContent).not.toContain('Log in to Odoo');
    });
});
