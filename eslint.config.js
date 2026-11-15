import js from '@eslint/js';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for the extension. Mirrors the MuK JS house rules
 * (4-space indent + single quotes are enforced by Prettier, not ESLint) and
 * adds TypeScript-aware linting. Formatting rules are intentionally omitted so
 * ESLint and Prettier do not fight.
 */
export default tseslint.config(
    {
        ignores: [
            'node_modules/**',
            '.output/**',
            '.wxt/**',
            'playwright-report/**',
            'test-results/**',
            'lib/playwright-aria/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.{ts,tsx}'],
        plugins: { jsdoc },
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.webextensions,
                ...globals.es2024,
            },
        },
        rules: {
            'no-debugger': 'error',
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-fallthrough': 'error',
            'no-duplicate-imports': 'error',
            'prefer-const': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-explicit-any': 'warn',
            'jsdoc/check-tag-names': 'warn',
            'jsdoc/check-types': 'warn',
        },
    },
    {
        files: ['tests/**/*', 'e2e/**/*'],
        languageOptions: {
            globals: { ...globals.node },
        },
    },
);
