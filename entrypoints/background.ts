import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import {
    type LinkState,
    type PairingReply,
    type PanelToSwMessage,
    type RuntimeMessage,
    type Status,
    type SwToPanelMessage,
} from '../lib/messaging';
import { getCheckpoint, patchCheckpoint } from '../lib/storage';
import { unpairedPatch } from '../lib/checkpoint';
import {
    OdooError,
    type PageCard,
    checkOdoo,
    fetchCard,
    isUnreachable,
    pair,
    unpair,
} from '../lib/odoo';
import { agentTabsOf, attach, joinAgentGroup, pollOnce } from '../lib/agent';
import { normalizeOdooUrl, webUrl } from '../lib/origin';
import { showInGroup, tabExists } from '../lib/runner';
import { errorText } from '../lib/util';
import { type UserAgentHints, deviceLabel } from '../lib/device';

/** Alarm that restarts polling after the worker was suspended. */
const KEEPALIVE_ALARM = 'muk-ai-keepalive';

/** Chat states in which the agent works and polling runs continuously. */
const BUSY_STATES = new Set(['running', 'compacting']);

/** Chat states in which the agent keeps its tab. */
const ENGAGED_STATES = new Set([...BUSY_STATES, 'waiting']);

/** Ids of the runtime-registered content scripts. */
const PAIRING_SCRIPT = 'muk-ai-pairing';
const LAUNCHER_SCRIPT = 'muk-ai-launcher';

/** How long the paired connect page shows its check mark before it closes. */
const CONNECT_CLOSE_MS = 1500;

/** Id of the context menu parent item. */
const MENU = 'muk-ai';

/** Context menu items on a selection, with the composer text (`%s` is the quote). */
const MENU_ITEMS: Record<string, { title: string; text: string }> = {
    'muk-ai-ask': { title: 'Ask MuK AI about this', text: '%s\n\n' },
    'muk-ai-contact': {
        title: 'Create a contact from this',
        text: 'Create a contact in Odoo from this text:\n\n%s',
    },
};

/**
 * Service worker: attaches this device to the chat the side panel's embedded
 * Odoo shows, polls its pending browser actions, runs them in the agent's tab
 * and owns pairing. It is the only context that calls the muk_ai_browser routes.
 */
export default defineBackground({
    type: 'module',
    main() {
        /** Open side panels and the window each one is open in. */
        const panels = new Map<chrome.runtime.Port, number | null>();
        let link: LinkState = 'idle';
        let lastError: string | null = null;
        let chatState = 'new';
        let actionsPending = false;
        let polling: Promise<void> | null = null;
        let wake: (() => void) | null = null;
        let scripts: Promise<void> = Promise.resolve();
        /** The card of the site the agent's tab was last on. */
        let card: { host: string; value: PageCard | null } | null = null;
        /** Composer text for the panel of a window, kept until that panel opens. */
        let compose: { text: string; windowId: number } | null = null;

        // ----------------------------------------------------------
        // Lifecycle
        // ----------------------------------------------------------

        void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        void browser.action.setBadgeBackgroundColor({ color: '#e8590c' });
        void syncContentScripts();
        void ensurePolling();

        browser.runtime.onInstalled.addListener(({ reason }) => {
            void syncContentScripts();
            void createMenus();
            if (reason === 'install') {
                void browser.runtime.openOptionsPage();
            }
        });
        browser.runtime.onStartup.addListener(() => void createMenus());
        browser.contextMenus.onClicked.addListener((info, tab) => {
            const item = MENU_ITEMS[String(info.menuItemId)];
            if (!item || tab?.id == null || !info.selectionText) {
                return;
            }
            void browser.sidePanel.open({ tabId: tab.id });
            const quote = info.selectionText
                .split('\n')
                .map((line) => `> ${line}`)
                .join('\n');
            compose = {
                text: item.text.replace('%s', () => quote),
                windowId: tab.windowId,
            };
            deliverCompose();
        });
        browser.permissions.onAdded.addListener(() => void syncContentScripts());
        browser.permissions.onRemoved.addListener(() => void syncContentScripts());
        browser.alarms.onAlarm.addListener((alarm) => {
            if (alarm.name === KEEPALIVE_ALARM) {
                void ensurePolling();
            }
        });
        browser.tabs.onRemoved.addListener((tabId) => {
            void getCheckpoint().then(async (cp) => {
                if (cp.agentTabId === tabId) {
                    await patchCheckpoint({ agentTabId: null });
                    await sendStatus();
                }
                if (cp.connectTabId === tabId) {
                    await patchCheckpoint({
                        connectTabId: null,
                        connectReturnTabId: null,
                    });
                    await sendStatus();
                }
            });
        });
        browser.tabs.onActivated.addListener(() => {
            if (panels.size) {
                void adoptActiveTab();
            }
        });
        browser.tabs.onUpdated.addListener((tabId, change) => {
            if (panels.size && change.groupId !== undefined) {
                void sendStatus();
            } else if (
                panels.size &&
                (change.title || change.url || change.favIconUrl)
            ) {
                void getCheckpoint().then(async (cp) => {
                    if (cp.agentTabId === tabId) {
                        await sendStatus();
                    }
                });
            }
        });

        // ----------------------------------------------------------
        // Runtime messages: panel, launcher, pairing reader, options page
        // ----------------------------------------------------------

        browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
            const reply = onRuntimeMessage(message as RuntimeMessage, sender);
            if (!reply) {
                return false;
            }
            void reply.then(sendResponse, (error: unknown) =>
                sendResponse({ ok: false, error: errorText(error) }),
            );
            return true;
        });

        /**
         * Handle a one-off runtime message.
         *
         * @param message - The message.
         * @param sender - Its sender.
         * @returns The reply, or `null` for a message without one.
         */
        function onRuntimeMessage(
            message: RuntimeMessage,
            sender: chrome.runtime.MessageSender,
        ): Promise<unknown> | null {
            const tab = sender.tab;
            switch (message.type) {
                case 'panel/check':
                    return getCheckpoint().then((cp) =>
                        cp.odooUrl ? checkOdoo(cp.odooUrl) : 'unreachable',
                    );
                case 'launcher/open-panel':
                    if (tab?.id != null) {
                        void browser.sidePanel.open({ tabId: tab.id });
                    }
                    return null;
                case 'launcher/hello':
                    return Promise.resolve(panelOpenIn(tab?.windowId));
                case 'pairing/code':
                    return pairFromPage(message.code, sender);
                case 'options/connect':
                    return openConnect(tab?.id ?? null);
                case 'options/set-url':
                    return setOdooUrl(message.url);
                case 'options/disconnect':
                    return disconnect().then(status);
                case 'options/status':
                    return status();
                default:
                    return null;
            }
        }

        // ----------------------------------------------------------
        // Context menu
        // ----------------------------------------------------------

        /** Create the context menu on a selection, replacing any earlier one. */
        async function createMenus(): Promise<void> {
            await browser.contextMenus.removeAll();
            browser.contextMenus.create({
                id: MENU,
                title: 'MuK AI Browser',
                contexts: ['selection'],
            });
            for (const [id, { title }] of Object.entries(MENU_ITEMS)) {
                browser.contextMenus.create({
                    id,
                    parentId: MENU,
                    title,
                    contexts: ['selection'],
                });
            }
        }

        /** Hand the composer text to the panel of its window once that panel opens. */
        function deliverCompose(): void {
            for (const [port, windowId] of panels) {
                if (compose && windowId === compose.windowId) {
                    port.postMessage({
                        type: 'sw/compose',
                        text: compose.text,
                    } satisfies SwToPanelMessage);
                    compose = null;
                }
            }
        }

        // ----------------------------------------------------------
        // Side panel port
        // ----------------------------------------------------------

        browser.runtime.onConnect.addListener((port) => {
            if (port.name !== 'muk-ai-panel') {
                return;
            }
            panels.set(port, null);
            port.onDisconnect.addListener(() => {
                const windowId = panels.get(port);
                panels.delete(port);
                void tellLaunchers(windowId);
                void updateKeepalive();
            });
            port.onMessage.addListener((message: PanelToSwMessage) => {
                void onPanelMessage(port, message).catch(fail);
            });
        });

        /**
         * Handle a side panel request.
         *
         * @param port - The panel's port.
         * @param message - The panel message.
         */
        async function onPanelMessage(
            port: chrome.runtime.Port,
            message: PanelToSwMessage,
        ): Promise<void> {
            switch (message.type) {
                case 'panel/open':
                    panels.set(port, message.windowId);
                    deliverCompose();
                    void tellLaunchers(message.windowId);
                    await adoptActiveTab();
                    await joinAgentGroup();
                    await sendStatus();
                    void ensurePolling();
                    return;
                case 'panel/attach':
                    await attachChat(message.chatId);
                    return;
                case 'panel/pair':
                    await pairWithCode(message.code);
                    await sendStatus();
                    return;
                case 'panel/connect': {
                    const windowId = panels.get(port);
                    const [active] = await browser.tabs.query(
                        windowId != null
                            ? { active: true, windowId }
                            : { active: true, lastFocusedWindow: true },
                    );
                    await openConnect(active?.id ?? null);
                    return;
                }
                case 'panel/show': {
                    const cp = await getCheckpoint();
                    if (!cp.odooUrl) {
                        return;
                    }
                    const tabs = await showInGroup(
                        `${cp.odooUrl}${message.path}`,
                        agentTabsOf(cp),
                    );
                    await patchCheckpoint({
                        agentGroupId: tabs.groupId,
                        agentOpenedTabIds: tabs.opened,
                    });
                    await sendStatus();
                    return;
                }
                case 'panel/focus-tab': {
                    const { agentTabId } = await getCheckpoint();
                    if (agentTabId != null && (await tabExists(agentTabId))) {
                        const tab = await browser.tabs.update(agentTabId, {
                            active: true,
                        });
                        if (tab?.windowId != null) {
                            await browser.windows.update(tab.windowId, {
                                focused: true,
                            });
                        }
                    }
                    return;
                }
            }
        }

        // ----------------------------------------------------------
        // Pairing
        // ----------------------------------------------------------

        /**
         * Open the Odoo connect page, or the options page while no Odoo is set.
         * An Odoo without the app gets an error instead of a page it lacks.
         *
         * @param returnTabId - The tab to return to once the page paired.
         */
        async function openConnect(returnTabId: number | null): Promise<void> {
            const cp = await getCheckpoint();
            if (!cp.odooUrl) {
                await browser.runtime.openOptionsPage();
                return;
            }
            if (await appMissing(cp.odooUrl)) {
                return;
            }
            const tab = await browser.tabs.create({
                url: `${cp.odooUrl}/muk_ai_browser/connect`,
            });
            await patchCheckpoint({
                connectTabId: tab.id ?? null,
                connectReturnTabId: returnTabId,
            });
            await sendStatus();
        }

        /**
         * Close the paired connect page after a moment and return to the tab
         * the user came from.
         *
         * @param tabId - The connect page's tab.
         * @param returnTabId - The tab to return to.
         */
        function leaveConnect(tabId: number, returnTabId: number | null): void {
            setTimeout(() => {
                void (async () => {
                    if (returnTabId != null && (await tabExists(returnTabId))) {
                        await browser.tabs.update(returnTabId, { active: true });
                    }
                    await browser.tabs.remove(tabId).catch(() => {});
                })();
            }, CONNECT_CLOSE_MS);
        }

        /**
         * Pair with a code the pairing reader found on the Odoo connect page.
         * The sender must be that page on the configured Odoo.
         *
         * @param code - The one-time code.
         * @param sender - The content script sender.
         * @returns The outcome the page shows.
         */
        async function pairFromPage(
            code: string,
            sender: chrome.runtime.MessageSender,
        ): Promise<PairingReply> {
            const { odooUrl, connectTabId, connectReturnTabId } = await getCheckpoint();
            const url = webUrl(sender.tab?.url ?? sender.url);
            if (
                !odooUrl ||
                url?.origin !== odooUrl ||
                !url.pathname.startsWith('/muk_ai_browser/connect')
            ) {
                return { ok: false, error: 'This page is not the configured Odoo.' };
            }
            const error = await pairWithCode(code);
            await sendStatus();
            if (error) {
                return { ok: false, error };
            }
            if (sender.tab?.id != null) {
                leaveConnect(
                    sender.tab.id,
                    sender.tab.id === connectTabId ? connectReturnTabId : null,
                );
            }
            return { ok: true };
        }

        /**
         * Exchange a pairing code for a device key.
         *
         * @param code - The one-time code.
         * @returns The error, or `null` once paired.
         */
        async function pairWithCode(code: string): Promise<string | null> {
            const cp = await getCheckpoint();
            if (!cp.odooUrl) {
                lastError = 'Set the Odoo URL in the extension options first.';
                return lastError;
            }
            try {
                const paired = await pair(
                    cp.odooUrl,
                    code.trim(),
                    currentDeviceLabel(),
                );
                await patchCheckpoint({
                    ...unpairedPatch(),
                    apiKey: paired.api_key,
                    user: paired.user,
                });
                lastError = null;
            } catch (error) {
                lastError = `Pairing failed: ${errorText(error)}`;
            }
            return lastError;
        }

        /**
         * Store a new Odoo URL. A different Odoo drops the current pairing.
         * The options page requested the host permission before.
         *
         * @param input - The URL the user entered.
         * @returns The status, or an error for an unusable URL.
         */
        async function setOdooUrl(
            input: string,
        ): Promise<Status | { ok: false; error: string }> {
            const origin = normalizeOdooUrl(input);
            if (!origin) {
                return {
                    ok: false,
                    error: 'Enter an https:// URL (http:// only for localhost).',
                };
            }
            const cp = await getCheckpoint();
            if (origin !== cp.odooUrl) {
                await disconnect();
                await patchCheckpoint({ odooUrl: origin });
            }
            await syncContentScripts();
            await appMissing(origin);
            return status();
        }

        /**
         * Check that an Odoo has the app, recording the error when it lacks it.
         *
         * @param odooUrl - The Odoo origin.
         * @returns Whether the app is missing.
         */
        async function appMissing(odooUrl: string): Promise<boolean> {
            const missing = (await checkOdoo(odooUrl)) === 'missing';
            lastError = missing ? new OdooError(404, 'app_missing').message : null;
            await sendStatus();
            return missing;
        }

        /** Revoke the device key (best effort) and forget the pairing. */
        async function disconnect(): Promise<void> {
            const cp = await getCheckpoint();
            if (cp.odooUrl && cp.apiKey) {
                await unpair(cp.odooUrl, cp.apiKey).catch(() => undefined);
            }
            await patchCheckpoint(unpairedPatch());
            card = null;
            chatState = 'new';
            actionsPending = false;
            await setBadge();
            await sendStatus();
        }

        /**
         * Register the pairing reader on the Odoo connect page and the
         * launcher on all sites but the Odoo, each only while its host
         * permission is held.
         */
        function syncContentScripts(): Promise<void> {
            scripts = scripts.then(async () => {
                const registered =
                    await browser.scripting.getRegisteredContentScripts();
                const ids = registered.map((script) => script.id);
                if (ids.length) {
                    await browser.scripting.unregisterContentScripts({ ids });
                }
                const { odooUrl } = await getCheckpoint();
                const wanted: Parameters<
                    typeof browser.scripting.registerContentScripts
                >[0] = [];
                if (
                    odooUrl &&
                    (await browser.permissions.contains({ origins: [`${odooUrl}/*`] }))
                ) {
                    wanted.push({
                        id: PAIRING_SCRIPT,
                        matches: [`${odooUrl}/muk_ai_browser/connect*`],
                        js: ['content-scripts/pairing.js'],
                        runAt: 'document_idle',
                    });
                }
                if (await browser.permissions.contains({ origins: ['<all_urls>'] })) {
                    wanted.push({
                        id: LAUNCHER_SCRIPT,
                        matches: ['<all_urls>'],
                        excludeMatches: odooUrl ? [`${odooUrl}/*`] : [],
                        js: ['content-scripts/launcher.js'],
                        runAt: 'document_idle',
                    });
                }
                if (wanted.length) {
                    await browser.scripting.registerContentScripts(wanted);
                }
            });
            scripts = scripts.catch(() => undefined);
            return scripts;
        }

        // ----------------------------------------------------------
        // Chat and agent tab
        // ----------------------------------------------------------

        /**
         * Attach this device to the chat the embedded Odoo opened and poll it.
         *
         * @param chatId - The `muk_ai.session` id.
         */
        async function attachChat(chatId: number): Promise<void> {
            await adoptActiveTab();
            try {
                await attach(chatId, currentDeviceLabel());
            } catch (error) {
                if (!(await forgetIfRevoked(error))) {
                    fail(error);
                }
                return;
            }
            setLink('online');
            await sendStatus();
            void ensurePolling();
        }

        /**
         * Make the active web tab the agent's tab while the agent is not
         * engaged or its tab is gone, so the next message acts on the page
         * the user looks at.
         */
        async function adoptActiveTab(): Promise<void> {
            const { agentTabId } = await getCheckpoint();
            if (
                (ENGAGED_STATES.has(chatState) || actionsPending) &&
                agentTabId != null &&
                (await tabExists(agentTabId))
            ) {
                return;
            }
            const [tab] = await browser.tabs.query({
                active: true,
                lastFocusedWindow: true,
            });
            if (tab?.id != null && tab.id !== agentTabId && webUrl(tab.url)) {
                await patchCheckpoint({ agentTabId: tab.id });
                await sendStatus();
            }
        }

        // ----------------------------------------------------------
        // Polling
        // ----------------------------------------------------------

        /**
         * Tell whether the agent works: its chat runs or an action waits.
         *
         * @returns Whether the agent works.
         */
        function working(): boolean {
            return BUSY_STATES.has(chatState) || actionsPending;
        }

        /**
         * Return how often the attached chat needs polling: continuously while
         * a panel is open or the agent works; every keepalive alarm while it
         * waits on the user; not at all otherwise.
         *
         * @returns The polling mode.
         */
        function pollMode(): 'fast' | 'slow' | 'off' {
            if (panels.size || working()) {
                return 'fast';
            }
            return chatState === 'waiting' ? 'slow' : 'off';
        }

        /**
         * Run the poll loop, or wake it when it waits for its next poll: at
         * least one poll, then more while the mode is `fast`.
         *
         * @returns The running loop.
         */
        function ensurePolling(): Promise<void> {
            wake?.();
            polling ??= pollLoop().finally(() => {
                polling = null;
                void updateKeepalive();
            });
            return polling;
        }

        /** Poll the attached chat and run its pending actions. */
        async function pollLoop(): Promise<void> {
            do {
                const cp = await getCheckpoint();
                if (!cp.apiKey || cp.browserSessionId == null) {
                    return;
                }
                await updateKeepalive();
                await adoptActiveTab();
                let response;
                try {
                    response = await pollOnce();
                } catch (error) {
                    if (!(await handleError(error))) {
                        await pause(5000);
                    }
                    continue;
                }
                setLink('online');
                const wasWorking = working();
                chatState = response.state;
                actionsPending = response.actions.length > 0;
                if (wasWorking && !working()) {
                    card = null;
                }
                if (working() && !wasWorking) {
                    await joinAgentGroup();
                }
                await setBadge();
                if (actionsPending || working() !== wasWorking) {
                    await sendStatus();
                }
                if (!actionsPending) {
                    await pause(response.retry_ms || 5000);
                }
            } while (pollMode() === 'fast');
        }

        /**
         * Wait before the next poll, cut short by {@link ensurePolling}.
         *
         * @param ms - Milliseconds.
         */
        async function pause(ms: number): Promise<void> {
            await new Promise<void>((resolve) => {
                wake = resolve;
                setTimeout(resolve, ms);
            });
            wake = null;
        }

        /** Keep the alarm that restarts polling exactly while polling is due. */
        async function updateKeepalive(): Promise<void> {
            if (pollMode() === 'off') {
                await browser.alarms.clear(KEEPALIVE_ALARM);
            } else if (!(await browser.alarms.get(KEEPALIVE_ALARM))) {
                await browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
            }
        }

        /**
         * Handle a failed request: 401 forgets the pairing, a lost browser
         * session attaches the chat again; anything else marks the link
         * offline.
         *
         * @param error - The error.
         * @returns Whether the error was handled.
         */
        async function handleError(error: unknown): Promise<boolean> {
            if (await forgetIfRevoked(error)) {
                return true;
            }
            if (
                error instanceof OdooError &&
                error.code === 'browser_session_not_found'
            ) {
                const { aiSessionId } = await patchCheckpoint({
                    browserSessionId: null,
                });
                if (aiSessionId != null) {
                    await attachChat(aiSessionId);
                }
                return true;
            }
            fail(error);
            return false;
        }

        /**
         * Forget the pairing when Odoo answered 401 (key revoked or unknown).
         *
         * @param error - The error.
         * @returns Whether it was a 401.
         */
        async function forgetIfRevoked(error: unknown): Promise<boolean> {
            if (!(error instanceof OdooError && error.status === 401)) {
                return false;
            }
            await patchCheckpoint(unpairedPatch());
            lastError = 'The connection to Odoo was revoked. Connect again.';
            link = 'idle';
            await sendStatus();
            return true;
        }

        // ----------------------------------------------------------
        // Status
        // ----------------------------------------------------------

        /**
         * Build the status the panel and the options page show.
         *
         * @returns The status.
         */
        async function status(): Promise<Status> {
            const cp = await getCheckpoint();
            let agentTab: Status['agentTab'] = null;
            if (cp.agentTabId != null && (await tabExists(cp.agentTabId))) {
                const tab = await browser.tabs.get(cp.agentTabId);
                agentTab = {
                    title: tab.title ?? '',
                    url: tab.url ?? '',
                    favIconUrl: tab.favIconUrl ?? null,
                };
            }
            const groupTabs =
                cp.agentGroupId == null
                    ? []
                    : await browser.tabs
                          .query({ groupId: cp.agentGroupId })
                          .catch(() => []);
            return {
                odooUrl: cp.odooUrl,
                paired: Boolean(cp.apiKey),
                userName: cp.user?.name ?? null,
                link,
                connecting: !cp.apiKey && cp.connectTabId != null,
                error: lastError,
                agentTab,
                groupTabs: groupTabs.length,
                working: working(),
                chatId: cp.aiSessionId,
                card: await cardOf(agentTab?.url),
            };
        }

        /**
         * Return the card of a page's site, fetched once per site and again after
         * the agent worked, since it may have created the company.
         *
         * @param url - The page of the agent's tab.
         * @returns The card, or `null` without one.
         */
        async function cardOf(url: string | undefined): Promise<PageCard | null> {
            const host = webUrl(url)?.host;
            const { odooUrl, apiKey } = await getCheckpoint();
            if (!host || !url || !odooUrl || !apiKey) {
                return null;
            }
            if (card?.host !== host) {
                card = {
                    host,
                    value: await fetchCard(odooUrl, apiKey, url).catch(() => null),
                };
            }
            return card.value;
        }

        /** Send the status to every open panel. */
        async function sendStatus(): Promise<void> {
            if (panels.size) {
                broadcast({ type: 'sw/status', status: await status() });
            }
        }

        /**
         * Change the link state, telling the panels only on a change.
         *
         * @param next - The new link state.
         */
        function setLink(next: LinkState): void {
            if (next === 'online') {
                lastError = null;
            }
            if (next !== link) {
                link = next;
                void sendStatus();
            }
        }

        /**
         * Record an unexpected error and show it: an Odoo that does not
         * answer is unreachable, any other failure leaves the link offline.
         *
         * @param error - The error.
         */
        function fail(error: unknown): void {
            lastError = errorText(error);
            link = isUnreachable(error) ? 'unreachable' : 'offline';
            void sendStatus();
        }

        /** Badge the toolbar button while the chat waits on the user. */
        async function setBadge(): Promise<void> {
            const waiting = chatState === 'waiting' && !actionsPending;
            await browser.action.setBadgeText({ text: waiting ? '!' : '' });
        }

        /**
         * Send a message to every open panel.
         *
         * @param message - The message.
         */
        function broadcast(message: SwToPanelMessage): void {
            for (const port of panels.keys()) {
                try {
                    port.postMessage(message);
                } catch {
                    panels.delete(port);
                }
            }
        }

        // ----------------------------------------------------------
        // Launchers
        // ----------------------------------------------------------

        /**
         * Tell whether a side panel is open in a window.
         *
         * @param windowId - The window.
         * @returns Whether one of the open panels is in it.
         */
        function panelOpenIn(windowId: number | null | undefined): boolean {
            return windowId != null && [...panels.values()].includes(windowId);
        }

        /**
         * Tell the launchers of a window whether its side panel is open; they
         * hide while it is.
         *
         * @param windowId - The window whose panel opened or closed.
         */
        async function tellLaunchers(
            windowId: number | null | undefined,
        ): Promise<void> {
            if (windowId == null) {
                return;
            }
            const message: RuntimeMessage = {
                type: 'launcher/panel',
                open: panelOpenIn(windowId),
            };
            for (const tab of await browser.tabs.query({ windowId })) {
                if (tab.id != null) {
                    browser.tabs.sendMessage(tab.id, message).catch(() => undefined);
                }
            }
        }
    },
});

/**
 * Return the device label sent on pairing and with each session.
 *
 * @returns E.g. `Chrome on Windows`.
 */
function currentDeviceLabel(): string {
    const hints = (navigator as Navigator & { userAgentData?: UserAgentHints })
        .userAgentData;
    return deviceLabel(hints, navigator.userAgent);
}
