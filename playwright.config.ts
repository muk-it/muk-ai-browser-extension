import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the extension e2e suite. The spec launches a
 * persistent Chromium context with the built MV3 extension loaded, so a build
 * must exist at `.output/chrome-mv3/` first (`npm run build`). Workers are
 * pinned to 1 because a persistent context owns a single browser profile.
 */
export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,
    workers: 1,
    reporter: 'list',
    timeout: 30_000,
    use: {
        trace: 'retain-on-failure',
    },
});
