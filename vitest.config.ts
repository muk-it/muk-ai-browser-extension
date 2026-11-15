import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration. Uses jsdom so perception, page actions and the side
 * panel run against a simulated DOM; tests mock `wxt/browser` where needed.
 */
export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.ts'],
        globals: true,
    },
});
