/**
 * Barrel for the vendored ARIA engine.
 *
 * Ported from Microsoft Playwright (packages/injected/src/roleUtils.ts,
 * ariaSnapshot.ts), Apache-2.0. See the per-file headers for attribution and
 * the NOTICE file at the repository root.
 */

export {
    INTERACTIVE_ROLES,
    NAME_FROM_CONTENT_ROLES,
    computeRole,
    isElementHiddenForAria,
} from './roles';
export { computeAccessibleName, normalizeWhitespace } from './accessibleName';
export { computeStates } from './states';
