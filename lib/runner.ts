import { browser } from 'wxt/browser';
import { type ToolResult, failure } from './messaging';
import { type Modifier, parseKey } from './keys';
import {
    type MouseButton,
    clickEvents,
    dispatchAll,
    keyEvents,
    trustedInputGranted,
    withDebugger,
} from './cdp';
import { type Mark, type Rect, renderScreenshot } from './screenshot';
import { routeTool, scopeRefusal } from './tools';
import { originOf, webUrl } from './origin';
import { errorText, sleep } from './util';

/**
 * Runs browser tool calls in the agent's tab group: content-script tools
 * through the on-demand content script, navigation, tabs and screenshots
 * through the extension APIs, and `trusted` input through the debugger. The
 * agent works in the "MuK AI" tab group: the tab it acts in joins it, and so
 * does every tab it opens, by navigation or by a link.
 */

/** Title of the agent's tab group. */
const GROUP_TITLE = 'MuK AI';

/** Built path of the on-demand content script. */
const CONTENT_SCRIPT = '/content-scripts/content.js';

/** The agent's tabs, as the runner reads and updates them. */
export interface AgentTabs {
    /** Tab the agent acts in. */
    tabId: number | null;
    /** The "MuK AI" tab group. */
    groupId: number | null;
    /** Tabs the agent opened itself, the only ones it closes. */
    opened: number[];
}

/** Outcome of a tool call. */
interface RunOutcome {
    result: ToolResult;
    /** The agent's tabs after the call. */
    tabs: AgentTabs;
    /** Origin of the agent's tab after the call. */
    origin: string | null;
}

/**
 * Run one tool call.
 *
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @param tabs - The agent's tabs.
 * @param planOrigins - Origins of the approved plan.
 * @returns The result and the agent's tabs afterwards.
 */
export async function runTool(
    name: string,
    args: Record<string, unknown>,
    tabs: AgentTabs,
    planOrigins: readonly string[],
): Promise<RunOutcome> {
    const state = { ...tabs, opened: [...tabs.opened] };
    let result: ToolResult;
    try {
        result = await dispatch(name, args, state, planOrigins);
    } catch (error) {
        result = failure('failed', errorText(error));
    }
    return { result, tabs: state, origin: await tabOrigin(state.tabId) };
}

/**
 * Route a call to its executor.
 *
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @param state - The agent's tabs, updated in place.
 * @param planOrigins - Origins of the approved plan.
 * @returns The tool result.
 */
async function dispatch(
    name: string,
    args: Record<string, unknown>,
    state: AgentTabs,
    planOrigins: readonly string[],
): Promise<ToolResult> {
    const route = routeTool(name, args);
    if (!route) {
        return failure('unknown_tool', `The browser does not know the tool ${name}.`);
    }
    if (route === 'tabs') {
        return tabsTool(args, state);
    }
    if (route === 'navigate' && (args.new_tab || state.tabId == null)) {
        return navigate(args, state);
    }
    if (state.tabId == null || !(await tabExists(state.tabId))) {
        state.tabId = null;
        return failure(
            'no_tab',
            'The agent has no tab: ask the user to open the page and send a message.',
        );
    }
    const tabId = state.tabId;
    const refusal = scopeRefusal(name, await tabOrigin(tabId), planOrigins);
    if (refusal) {
        return refusal;
    }
    await joinGroup(tabId, state);
    switch (route) {
        case 'content':
            return followNewTab(state, () => contentCall(tabId, name, args));
        case 'trusted':
            return followNewTab(state, () => trusted(tabId, name, args));
        case 'navigate':
            return navigate(args, state);
        case 'navigate_back':
            await browser.tabs.goBack(state.tabId);
            return loaded(state.tabId);
        case 'screenshot':
            return screenshot(state.tabId, args);
    }
}

// ----------------------------------------------------------
// Content script
// ----------------------------------------------------------

/**
 * Run a tool in a tab's content script, injecting it when no tool answers
 * (the tab may hold other extension listeners, such as the launcher). A page
 * that unloads while an agent tool runs was navigated by it: the tool is not
 * run again, and its result is the loaded page.
 *
 * @param tabId - The tab.
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @returns The tool result.
 */
async function contentCall(
    tabId: number,
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const message = { type: 'content/tool', name, arguments: args };
    try {
        return (await browser.tabs.sendMessage(tabId, message)) as ToolResult;
    } catch (error) {
        if (/asynchronous response/.test(errorText(error))) {
            return name.startsWith('_') || name === 'browser_read_page'
                ? failure('page_changed', 'The page changed meanwhile: read it again.')
                : loaded(tabId);
        }
    }
    try {
        await browser.scripting.executeScript({
            target: { tabId },
            files: [CONTENT_SCRIPT],
        });
    } catch (error) {
        return failure(
            'no_access',
            `The extension may not access this tab (${errorText(error)}). ` +
                'Ask the user to allow MuK AI Browser on all sites in its options, ' +
                'or to click the MuK AI toolbar button on this tab.',
        );
    }
    return (await browser.tabs.sendMessage(tabId, message)) as ToolResult;
}

// ----------------------------------------------------------
// Navigation and tabs
// ----------------------------------------------------------

/**
 * Navigate the agent's tab, or a new agent tab, and read the loaded page.
 *
 * @param args - `url`, `new_tab`.
 * @param state - The agent's tabs, updated in place.
 * @returns The navigation result with a fresh snapshot.
 */
async function navigate(
    args: Record<string, unknown>,
    state: AgentTabs,
): Promise<ToolResult> {
    const url = webUrl(args.url)?.href;
    if (!url) {
        return failure('bad_url', 'browser_navigate only opens http and https URLs.');
    }
    if (args.new_tab || state.tabId == null) {
        state.tabId = await openAgentTab(url, state);
    } else {
        await browser.tabs.update(state.tabId, { url });
    }
    return loaded(state.tabId);
}

/**
 * Run a call that may open a tab, such as a click on a link with a target,
 * and move the agent into the tab it opened.
 *
 * @param state - The agent's tabs, updated in place.
 * @param call - The call.
 * @returns The call's result, or the page of the tab it opened.
 */
async function followNewTab(
    state: AgentTabs,
    call: () => Promise<ToolResult>,
): Promise<ToolResult> {
    const opener = state.tabId;
    const before = new Set((await browser.tabs.query({})).map((tab) => tab.id));
    const result = await call();
    const opened = (await browser.tabs.query({})).find(
        (tab) => tab.id != null && !before.has(tab.id) && tab.openerTabId === opener,
    );
    if (!result.ok || opened?.id == null) {
        return result;
    }
    state.tabId = opened.id;
    state.opened.push(opened.id);
    await joinGroup(opened.id, state);
    const page = await loaded(opened.id);
    return page.ok ? { ...page, opened_tab: opened.id } : page;
}

/**
 * Wait for a tab to finish loading and return its URL, title and snapshot.
 *
 * @param tabId - The tab.
 * @returns The page result.
 */
async function loaded(tabId: number): Promise<ToolResult> {
    await waitForComplete(tabId);
    const tab = await browser.tabs.get(tabId);
    const read = await contentCall(tabId, 'browser_read_page', {});
    return {
        ok: true,
        url: tab.url ?? '',
        title: tab.title ?? '',
        snapshot: read.ok ? read.snapshot : '',
        ...(read.ok ? {} : { snapshot_error: read.message }),
    };
}

/**
 * Poll a tab until it reports `complete`, at most 15 seconds.
 *
 * @param tabId - The tab.
 */
async function waitForComplete(tabId: number): Promise<void> {
    const deadline = Date.now() + 15000;
    await sleep(300);
    while (Date.now() < deadline) {
        if ((await browser.tabs.get(tabId)).status === 'complete') {
            return;
        }
        await sleep(200);
    }
}

/**
 * Open a tab for the agent next to its current tab, in its tab group.
 *
 * @param url - URL to open.
 * @param state - The agent's tabs, updated in place.
 * @returns The new tab id.
 */
async function openAgentTab(url: string, state: AgentTabs): Promise<number> {
    const current =
        state.tabId != null && (await tabExists(state.tabId))
            ? await browser.tabs.get(state.tabId)
            : null;
    const tab = await browser.tabs.create({
        url,
        active: true,
        ...(current ? { windowId: current.windowId, index: current.index + 1 } : {}),
    });
    const tabId = tab.id as number;
    state.opened.push(tabId);
    await joinGroup(tabId, state);
    return tabId;
}

/**
 * Show a page to the user in the agent's tab group, next to the tab the agent
 * acts in: a group tab on the same site is reused, else a new one opens. The
 * agent keeps acting in its tab.
 *
 * @param url - The page.
 * @param tabs - The agent's tabs.
 * @returns The agent's tabs afterwards.
 */
export async function showInGroup(url: string, tabs: AgentTabs): Promise<AgentTabs> {
    const state = await groupAgentTab(tabs);
    const shown =
        state.groupId == null
            ? undefined
            : (await browser.tabs.query({ groupId: state.groupId })).find(
                  (tab) =>
                      tab.id !== state.tabId && originOf(tab.url) === originOf(url),
              );
    if (shown?.id != null) {
        await browser.tabs.update(shown.id, { url, active: true });
    } else {
        await openAgentTab(url, state);
    }
    return state;
}

/**
 * Put the agent's tab into the "MuK AI" tab group, as when a task starts.
 *
 * @param tabs - The agent's tabs.
 * @returns The agent's tabs afterwards.
 */
export async function groupAgentTab(tabs: AgentTabs): Promise<AgentTabs> {
    const state = { ...tabs, opened: [...tabs.opened] };
    if (state.tabId != null && (await tabExists(state.tabId))) {
        await joinGroup(state.tabId, state);
    }
    return state;
}

/**
 * Add a tab to the agent's tab group, creating the group when it is gone.
 * While Chrome blocks tab edits, as during a tab drag, it retries for two
 * seconds; a tab Chrome refuses to group stays where it is.
 *
 * @param tabId - The tab.
 * @param state - The agent's tabs; `groupId` is updated in place.
 */
async function joinGroup(tabId: number, state: AgentTabs): Promise<void> {
    const { groupId } = state;
    if (groupId != null && (await browser.tabs.get(tabId)).groupId === groupId) {
        return;
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            state.groupId = await browser.tabs
                .group({ tabIds: [tabId], ...(groupId != null ? { groupId } : {}) })
                .catch(() => browser.tabs.group({ tabIds: [tabId] }));
            await browser.tabGroups.update(state.groupId, {
                title: GROUP_TITLE,
                color: 'blue',
            });
            return;
        } catch (error) {
            if (!/cannot be edited/i.test(errorText(error))) {
                return;
            }
            await sleep(200);
        }
    }
}

/**
 * List, select, open or close the agent's tabs: the tabs of its group plus
 * the tab it acts in. It closes only the tabs it opened.
 *
 * @param args - `action`, `tab_id`, `url`.
 * @param state - The agent's tabs, updated in place.
 * @returns The tab list after the action.
 */
async function tabsTool(
    args: Record<string, unknown>,
    state: AgentTabs,
): Promise<ToolResult> {
    const action = String(args.action ?? 'list');
    const tabId = args.tab_id == null ? null : Number(args.tab_id);
    const allowed = await agentTabs(state);
    if (action === 'new') {
        const url = args.url == null ? 'about:blank' : webUrl(args.url)?.href;
        if (!url) {
            return failure('bad_url', 'browser_tabs only opens http and https URLs.');
        }
        state.tabId = await openAgentTab(url, state);
        if (url !== 'about:blank') {
            await waitForComplete(state.tabId);
        }
    } else if (action === 'select' || action === 'close') {
        const target = tabId ?? state.tabId;
        const tab = allowed.find((candidate) => candidate.id === target);
        if (target == null) {
            return failure('no_tab', 'The agent has no tab: give a tab_id.');
        }
        if (!tab) {
            return failure(
                'unknown_tab',
                `Tab ${target} is not one of the agent's tabs.`,
            );
        }
        if (action === 'select') {
            state.tabId = target;
            await browser.tabs.update(target, { active: true });
        } else {
            if (!state.opened.includes(target)) {
                return failure(
                    'not_agent_tab',
                    "The agent only closes tabs it opened; this is the user's tab.",
                );
            }
            await browser.tabs.remove(target);
            state.opened = state.opened.filter((id) => id !== target);
            if (state.tabId === target) {
                state.tabId =
                    allowed.find((candidate) => candidate.id !== target)?.id ?? null;
            }
        }
    } else if (action !== 'list') {
        return failure(
            'bad_arguments',
            'browser_tabs action is one of list, select, new, close.',
        );
    }
    const tabs = (await agentTabs(state)).map((tab) => ({
        tab_id: tab.id,
        title: tab.title ?? '',
        url: tab.url ?? '',
        current: tab.id === state.tabId,
    }));
    return { ok: true, tabs };
}

/**
 * Return the tabs the agent may use.
 *
 * @param state - The agent's tabs.
 * @returns Its group's tabs plus its current tab.
 */
async function agentTabs(state: AgentTabs): Promise<chrome.tabs.Tab[]> {
    const grouped =
        state.groupId != null
            ? await browser.tabs.query({ groupId: state.groupId })
            : [];
    if (
        state.tabId != null &&
        !grouped.some((tab) => tab.id === state.tabId) &&
        (await tabExists(state.tabId))
    ) {
        grouped.unshift(await browser.tabs.get(state.tabId));
    }
    return grouped;
}

// ----------------------------------------------------------
// Screenshot
// ----------------------------------------------------------

/**
 * Capture the agent's tab, drawing marks and cropping to `ref` as asked.
 *
 * @param tabId - The tab.
 * @param args - `marks`, `ref`.
 * @returns `{images: [dataUrl]}`.
 */
async function screenshot(
    tabId: number,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const measured = await contentCall(tabId, '_layout', {
        marks: args.marks === true,
        ref: args.ref,
    });
    if (!measured.ok) {
        return measured;
    }
    const tab = await browser.tabs.get(tabId);
    if (!tab.active) {
        await browser.tabs.update(tabId, { active: true });
        await sleep(200);
    }
    const raw = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const image = await renderScreenshot(raw, {
        dpr: Number(measured.dpr) || 1,
        marks: measured.marks as Mark[],
        crop: (measured.crop as Rect | null) ?? null,
    });
    return { ok: true, images: [image] };
}

// ----------------------------------------------------------
// Trusted input
// ----------------------------------------------------------

/**
 * Run a click, typing or key press as trusted CDP input.
 *
 * @param tabId - The tab.
 * @param name - `browser_click`, `browser_type` or `browser_press_key`.
 * @param args - Tool arguments.
 * @returns The result with a fresh snapshot.
 */
async function trusted(
    tabId: number,
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    if (!(await trustedInputGranted())) {
        return failure(
            'trusted_input_unavailable',
            'Trusted input is not available in this installation of MuK AI Browser. ' +
                'Retry without trusted, or ask the user to do this step.',
        );
    }
    const point = await contentCall(tabId, '_locate', {
        ref: args.ref,
        keyboard: name !== 'browser_click',
        select: name === 'browser_type',
    });
    if (!point.ok) {
        return point;
    }
    await withDebugger(tabId, async (send) => {
        if (name === 'browser_click') {
            const modifiers = (
                Array.isArray(args.modifiers) ? args.modifiers : []
            ) as Modifier[];
            const events = clickEvents(
                Number(point.x),
                Number(point.y),
                (args.button as MouseButton) ?? 'left',
                Boolean(args.double),
                modifiers,
            );
            await dispatchAll(send, 'Input.dispatchMouseEvent', events);
        } else if (name === 'browser_type') {
            const text = String(args.text ?? '');
            if (text) {
                await send('Input.insertText', { text });
            } else {
                await dispatchAll(
                    send,
                    'Input.dispatchKeyEvent',
                    keyEvents(parseKey('Backspace')),
                );
            }
            if (args.submit) {
                await dispatchAll(
                    send,
                    'Input.dispatchKeyEvent',
                    keyEvents(parseKey('Enter')),
                );
            }
        } else {
            await dispatchAll(
                send,
                'Input.dispatchKeyEvent',
                keyEvents(parseKey(String(args.key ?? ''))),
            );
        }
    });
    return contentCall(tabId, '_settle', {});
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

/**
 * Tell whether a tab still exists.
 *
 * @param tabId - The tab.
 * @returns Whether `tabs.get` finds it.
 */
export async function tabExists(tabId: number): Promise<boolean> {
    try {
        await browser.tabs.get(tabId);
        return true;
    } catch {
        return false;
    }
}

/**
 * Return a tab's origin.
 *
 * @param tabId - The tab, or `null`.
 * @returns Its `http(s)` origin, or `null`.
 */
export async function tabOrigin(tabId: number | null): Promise<string | null> {
    if (tabId == null || !(await tabExists(tabId))) {
        return null;
    }
    return originOf((await browser.tabs.get(tabId)).url);
}
