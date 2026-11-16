import { defineConfig } from 'wxt';

/**
 * Public half of the signing key: pins the extension id to
 * `ogglimafigjflmiccojhjlljohnoabph` for unpacked and self-hosted builds.
 * The private key stays out of the repository (`.keys/`, gitignored). The
 * Chrome Web Store build (`--mode store`) leaves it out: the store assigns
 * its own id and rejects a manifest with a `key`.
 */
const PUBLIC_KEY =
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAko7/joKOKFIBnlmHYT1IqvRKw6lDWKJdw/GDe5orXImquECP5hwsPX1IhWqlYmP9oPIydZKadw0DAiQFsLZhIsBwMGXxN3C1W6Ky8AwsO85/OxCl/8s4V4t28EKSK+tlyCyztxYHsrFcD5W1MOpq3Pj/ELCDr2p6+iD7WJTMmIZvgiLeKIYsr2ruECqhttg3xqAdtv9c8Sv4q67Rp/7BZnvkuOEEzaBC+odc5+PL4cYjaIdBPZTEa40f2NcG+Sm+8QjXSzirGyGjJH8Ibgx61csx9PibgXliGjYLpJRfZIGQTFnKgdLo9/FHYO1YuLbIHuVi7SWTilpk8sx2BtZaCwIDAQAB';

/**
 * WXT configuration (Chrome MV3). The extension is the actuator of the
 * muk_ai_browser Odoo app and embeds its chat; the Odoo address is configured
 * at runtime, so no host is granted at install: the user grants their Odoo on
 * the options page, and optionally all sites. Trusted input needs `debugger` in
 * `permissions`: Chrome does not allow it as an optional permission.
 */
export default defineConfig({
    modules: ['@wxt-dev/module-react'],
    srcDir: '.',
    manifest: ({ mode }) => ({
        name: 'MuK AI Browser',
        description:
            'Let a MuK AI agent from your Odoo read and act on the pages you work on. Requires the MuK AI Browser Odoo app.',
        ...(mode === 'store' ? {} : { key: PUBLIC_KEY }),
        minimum_chrome_version: '116',
        permissions: [
            'activeTab',
            'alarms',
            'contextMenus',
            'scripting',
            'storage',
            'tabGroups',
            'tabs',
        ],
        optional_host_permissions: ['<all_urls>'],
        action: { default_title: 'Open MuK AI' },
        commands: { _execute_action: { suggested_key: { default: 'Alt+M' } } },
        content_security_policy: {
            extension_pages:
                "script-src 'self'; object-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*;",
        },
    }),
});
