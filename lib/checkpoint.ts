/**
 * Pure checkpoint shapes and helpers, free of the extension storage runtime so
 * they are testable in a plain environment. The chat itself lives in Odoo.
 */

/** The paired Odoo user. */
interface PairedUser {
    id: number;
    name: string;
}

/** Everything the service worker persists between restarts. */
export interface Checkpoint {
    /** Origin of the configured Odoo, from the options page. */
    odooUrl: string | null;
    /** Bearer device key returned by `/pair`. */
    apiKey: string | null;
    /** The Odoo user the device acts for. */
    user: PairedUser | null;
    /** Active `muk_ai_browser` session token. */
    browserSessionId: string | null;
    /** The `muk_ai.session` chat behind it, reopened in the side panel. */
    aiSessionId: number | null;
    /** Tab the agent acts in. */
    agentTabId: number | null;
    /** The "MuK AI" tab group the agent works in. */
    agentGroupId: number | null;
    /** Tabs the agent opened itself. */
    agentOpenedTabIds: number[];
    /** The Odoo connect page the extension opened, closed once it paired. */
    connectTabId: number | null;
    /** The tab to return to when the connect page closes. */
    connectReturnTabId: number | null;
    /**
     * Call ids already run (newest last). A re-poll never runs one twice; one
     * still pending after it ran lost its result (worker restart, network).
     */
    executed: string[];
}

/** Checkpoint of a fresh install. */
export const DEFAULT_CHECKPOINT: Checkpoint = {
    odooUrl: null,
    apiKey: null,
    user: null,
    browserSessionId: null,
    aiSessionId: null,
    agentTabId: null,
    agentGroupId: null,
    agentOpenedTabIds: [],
    connectTabId: null,
    connectReturnTabId: null,
    executed: [],
};

/** How many executed call ids are remembered. */
const EXECUTED_CAP = 200;

/**
 * Return the checkpoint fields that forget the pairing but keep the Odoo URL.
 *
 * @returns The patch that resets pairing and session.
 */
export function unpairedPatch(): Partial<Checkpoint> {
    const { odooUrl: _keep, ...rest } = DEFAULT_CHECKPOINT;
    return rest;
}

/**
 * Add a call id to the executed list, keeping the newest {@link EXECUTED_CAP}.
 *
 * @param executed - The current list.
 * @param callId - The call id that ran.
 * @returns The new list.
 */
export function rememberExecuted(
    executed: readonly string[],
    callId: string,
): string[] {
    return [...executed.filter((id) => id !== callId), callId].slice(-EXECUTED_CAP);
}
