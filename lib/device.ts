/** The parts of `navigator.userAgentData` the label reads. */
export interface UserAgentHints {
    brands?: readonly { brand: string }[];
    platform?: string;
}

/** Browsers by user-agent brand or token, most specific first. */
const BROWSERS: [RegExp, string][] = [
    [/Microsoft Edge|Edg\//, 'Edge'],
    [/Opera|OPR\//, 'Opera'],
    [/Brave/, 'Brave'],
    [/Google Chrome|Chrome\//, 'Chrome'],
    [/Chromium/, 'Chromium'],
];

/** Operating systems by platform hint or user-agent token. */
const SYSTEMS: [RegExp, string][] = [
    [/Windows/, 'Windows'],
    [/mac/i, 'macOS'],
    [/Chrome ?OS|CrOS/, 'ChromeOS'],
    [/Android/, 'Android'],
    [/Linux/, 'Linux'],
];

/**
 * Name this browser the way Odoo lists it under Connected Browsers.
 *
 * @param hints - `navigator.userAgentData`, when the browser has it.
 * @param userAgent - `navigator.userAgent`, the fallback.
 * @returns E.g. `Chrome on Windows`.
 */
export function deviceLabel(
    hints: UserAgentHints | undefined,
    userAgent: string,
): string {
    const brands = hints?.brands?.map(({ brand }) => brand).join(' ') || userAgent;
    const browser = BROWSERS.find(([pattern]) => pattern.test(brands))?.[1] ?? 'Chrome';
    const platform = hints?.platform || userAgent;
    const system = SYSTEMS.find(([pattern]) => pattern.test(platform))?.[1];
    return system ? `${browser} on ${system}` : browser;
}
