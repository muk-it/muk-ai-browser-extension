/**
 * URL helpers: normalising the user-entered Odoo URL, parsing web URLs and
 * matching an origin against the approved plan scope.
 */

/**
 * Hosts that may be reached over plain `http:` (local development only). The
 * same hosts are in the extension pages' `connect-src` (`wxt.config.ts`).
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Normalise the Odoo URL from the options page to its origin. `https:` is
 * accepted for any host, `http:` only for a local host, so the device key never
 * travels in clear text over a network. Without a scheme a local host gets
 * `http:` and any other host `https:`.
 *
 * @param input - What the user typed (with or without a path or scheme).
 * @returns The origin, or `null` when the URL is unusable.
 */
export function normalizeOdooUrl(input: string): string | null {
    const raw = input.trim();
    if (!raw) {
        return null;
    }
    const scheme = /^[a-z]+:\/\//i.test(raw);
    let url: URL;
    try {
        url = new URL(scheme ? raw : `https://${raw}`);
    } catch {
        return null;
    }
    if (!scheme && LOCAL_HOSTS.has(url.hostname)) {
        url.protocol = 'http:';
    }
    if (url.protocol === 'https:') {
        return url.origin;
    }
    if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) {
        return url.origin;
    }
    return null;
}

/**
 * Parse an `http(s)` URL.
 *
 * @param url - Anything, typically a URL string.
 * @returns The parsed URL, or `null` for other schemes and non-URLs.
 */
export function webUrl(url: unknown): URL | null {
    if (typeof url !== 'string') {
        return null;
    }
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
            ? parsed
            : null;
    } catch {
        return null;
    }
}

/**
 * Return the origin of a web URL.
 *
 * @param url - Anything, typically a URL string.
 * @returns The `http(s)` origin, or `null`.
 */
export function originOf(url: unknown): string | null {
    return webUrl(url)?.origin ?? null;
}

/**
 * Test whether an origin is covered by the approved plan scope. An entry
 * matches exactly, or as `[scheme://]*.domain`, which covers the domain and
 * every subdomain.
 *
 * @param origin - The origin to test.
 * @param scope - The plan origins; empty means no plan.
 * @returns Whether the origin is in scope.
 */
export function originInScope(
    origin: string | null,
    scope: readonly string[],
): boolean {
    if (!origin) {
        return false;
    }
    const { protocol, hostname } = new URL(origin);
    return scope.some((entry) => {
        if (entry === origin) {
            return true;
        }
        const match = /^(?:([a-z]+):\/\/)?\*\.([^/:]+)/i.exec(entry);
        if (!match) {
            return false;
        }
        const [, scheme, domain] = match;
        if (scheme && `${scheme.toLowerCase()}:` !== protocol) {
            return false;
        }
        const base = domain.toLowerCase();
        return hostname === base || hostname.endsWith(`.${base}`);
    });
}
