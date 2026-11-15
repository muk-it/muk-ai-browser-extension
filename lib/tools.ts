import { type ToolResult, failure } from './messaging';
import { MUTATING_TOOLS } from './actions';
import { originInScope, originOf } from './origin';

/**
 * Pure routing of browser tool calls: where a call runs, and whether it may
 * run on the tab's current origin.
 */

/** Where a tool call runs. */
export type Route =
    'content' | 'trusted' | 'navigate' | 'navigate_back' | 'tabs' | 'screenshot';

/** Tools the content script runs. */
const CONTENT_TOOLS = new Set([
    'browser_read_page',
    'browser_find',
    'browser_click',
    'browser_type',
    'browser_fill_form',
    'browser_select_option',
    'browser_press_key',
    'browser_hover',
    'browser_scroll',
    'browser_wait_for',
]);

/** Tools that accept `trusted: true`. */
const TRUSTED_TOOLS = new Set(['browser_click', 'browser_type', 'browser_press_key']);

/** Tools the service worker runs itself. */
const WORKER_TOOLS: Record<string, Route> = {
    browser_navigate: 'navigate',
    browser_navigate_back: 'navigate_back',
    browser_tabs: 'tabs',
    browser_screenshot: 'screenshot',
};

/**
 * Decide where a tool call runs.
 *
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @returns The route, or `null` for an unknown tool.
 */
export function routeTool(name: string, args: Record<string, unknown>): Route | null {
    if (TRUSTED_TOOLS.has(name) && args.trusted === true) {
        return 'trusted';
    }
    if (CONTENT_TOOLS.has(name)) {
        return 'content';
    }
    return WORKER_TOOLS[name] ?? null;
}

/**
 * Refuse a page-changing call on an origin outside an approved plan. The
 * server gated the call on the origin it last saw; this catches a tab that
 * moved to another site since (a redirect, or the user navigating).
 * Navigation is exempt: the server asks before leaving the plan.
 *
 * @param name - Tool name.
 * @param origin - Current origin of the agent's tab.
 * @param planOrigins - Origins of the approved plan; empty means no plan.
 * @returns A refusal, or `null` when the call may run.
 */
export function scopeRefusal(
    name: string,
    origin: string | null,
    planOrigins: readonly string[],
): ToolResult | null {
    if (
        planOrigins.length === 0 ||
        !MUTATING_TOOLS.has(name) ||
        name === 'browser_navigate' ||
        name === 'browser_navigate_back' ||
        originInScope(origin, planOrigins)
    ) {
        return null;
    }
    return failure(
        'out_of_plan',
        `The tab is now on ${origin ?? 'a page without an origin'}, outside the approved plan ` +
            `(${planOrigins.join(', ')}). Read the page again, or propose a new plan.`,
    );
}

/**
 * Refuse a call the server judged on another origin than the agent's tab has
 * now (the tab navigated between the decision and the run).
 *
 * @param judged - The origin the server judged the call on, if any.
 * @param current - Current origin of the agent's tab.
 * @returns A refusal, or `null` when the call may run.
 */
export function originRefusal(
    judged: string | undefined,
    current: string | null,
): ToolResult | null {
    if (judged == null || originOf(judged) === current) {
        return null;
    }
    return failure(
        'origin_changed',
        `The tab moved to ${current ?? 'a page without an origin'} before this action ran; ` +
            'read the page again.',
    );
}
