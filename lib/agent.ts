import { type Checkpoint, rememberExecuted } from './checkpoint';
import type { ToolResult } from './messaging';
import {
    type PendingAction,
    type PollResponse,
    openSession,
    poll,
    postResult,
} from './odoo';
import { type AgentTabs, agentTabs, groupAgentTab, runTool, tabOrigin } from './runner';
import { originOf } from './origin';
import { originRefusal, routeTool } from './tools';
import { getCheckpoint, patchCheckpoint } from './storage';

/**
 * The actuator side of a chat: attach this device to the chat open in the
 * embedded Odoo, poll its pending browser actions, run each once in the
 * agent's tab and post the results. The service worker drives the timing.
 */

/** Result posted for an action that ran but whose result never arrived. */
export const RESULT_LOST: ToolResult = {
    ok: false,
    error: 'result_lost',
    message:
        'The action was interrupted or its result was lost. Read the page to check ' +
        'whether it took effect before retrying.',
};

/**
 * Attach this device to a chat and store the browser session.
 *
 * @param aiSessionId - The chat open in the embedded Odoo.
 * @param deviceLabel - Human name of this browser.
 */
export async function attach(aiSessionId: number, deviceLabel: string): Promise<void> {
    const cp = await getCheckpoint();
    if (!cp.odooUrl || !cp.apiKey) {
        return;
    }
    const opened = await openSession(
        cp.odooUrl,
        cp.apiKey,
        aiSessionId,
        deviceLabel,
        await tabOrigin(cp.agentTabId),
    );
    await patchCheckpoint({
        browserSessionId: opened.browser_session_id,
        aiSessionId: opened.ai_session_id,
    });
}

/** Put the agent's tab into the "MuK AI" tab group, creating the group. */
export async function joinAgentGroup(): Promise<void> {
    const tabs = await groupAgentTab(agentTabsOf(await getCheckpoint()));
    await patchCheckpoint({ agentGroupId: tabs.groupId });
}

/**
 * Poll the attached chat once and run its pending actions. The poll names
 * the agent's tabs and their origins, on which Odoo judges a `tab_id` call.
 *
 * @returns The poll response.
 */
export async function pollOnce(): Promise<PollResponse> {
    const cp = await getCheckpoint();
    const tabs = (await agentTabs(agentTabsOf(cp))).map((tab) => ({
        id: tab.id as number,
        origin: originOf(tab.url) ?? '',
    }));
    const response = await poll(cp, (await tabOrigin(cp.agentTabId)) ?? '', tabs);
    for (const action of response.actions) {
        await runAction(action, response.plan_origins ?? []);
    }
    return response;
}

/**
 * Run a pending action once and post its result. An action already run
 * whose result the server still lacks is answered as lost; one judged on
 * another origin than the tab it runs in has now is refused.
 *
 * @param action - The pending action.
 * @param planOrigins - Origins of the approved plan.
 */
async function runAction(action: PendingAction, planOrigins: string[]): Promise<void> {
    const cp = await getCheckpoint();
    if (cp.executed.includes(action.call_id)) {
        await postResult(cp, action.call_id, null, RESULT_LOST);
        return;
    }
    const origin = await tabOrigin(cp.agentTabId);
    const refusal = originRefusal(
        action.origin,
        routeTool(action.name, action.arguments ?? {}) === 'other_tab'
            ? await tabOrigin(Number(action.arguments.tab_id))
            : origin,
    );
    if (refusal) {
        await postResult(cp, action.call_id, origin, refusal);
        return;
    }
    await patchCheckpoint({ executed: rememberExecuted(cp.executed, action.call_id) });
    const outcome = await runTool(action, agentTabsOf(cp), planOrigins, cp);
    await patchCheckpoint({
        agentTabId: outcome.tabs.tabId,
        agentGroupId: outcome.tabs.groupId,
        agentOpenedTabIds: outcome.tabs.opened,
    });
    await postResult(cp, action.call_id, outcome.origin, outcome.result);
}

/**
 * Return the agent's tabs as the checkpoint stores them.
 *
 * @param cp - The checkpoint.
 * @returns The agent's tabs.
 */
export function agentTabsOf(cp: Checkpoint): AgentTabs {
    return {
        tabId: cp.agentTabId,
        groupId: cp.agentGroupId,
        opened: cp.agentOpenedTabIds,
    };
}
