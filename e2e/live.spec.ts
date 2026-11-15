import { test, expect } from '@playwright/test';
import { FIXTURE, type Launched, type Served, launch, serve } from './helpers';

/**
 * Live e2e against a real Odoo with muk_ai_browser and a configured AI
 * provider, through the real UI only: options page, pasted pairing code, side
 * panel with the embedded muk_ai chat, approvals. Skipped unless both are set:
 *
 * - `ODOO_URL`: e.g. `http://localhost:8069` (one database, dbfilter)
 * - `PAIR_CODE`: a fresh code from `<odoo>/muk_ai_browser/connect`
 */

const ODOO_URL = process.env.ODOO_URL ?? '';
const PAIR_CODE = process.env.PAIR_CODE ?? '';

let browser: Launched;
let site: Served;

test.skip(
    !ODOO_URL || !PAIR_CODE,
    'set ODOO_URL and PAIR_CODE to run against a live Odoo',
);

test.beforeAll(async () => {
    browser = await launch();
    site = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(FIXTURE);
    });
});

test.afterAll(async () => {
    await browser?.close();
    await site?.close();
});

test('an agent reads the page and clicks a button from the side panel', async () => {
    test.setTimeout(300_000);
    const { context, extensionId } = browser;

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.getByLabel('Odoo URL').fill(ODOO_URL);
    await options.getByRole('button', { name: 'Save' }).click();
    await expect(options.getByText('Not connected')).toBeVisible();

    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.getByLabel('Pairing code').fill(PAIR_CODE);
    await panel.getByRole('button', { name: 'Pair' }).click();
    const chat = panel.frameLocator('iframe.mk-frame');
    const composer = chat.locator('textarea').first();
    await expect(composer).toBeVisible({ timeout: 20_000 });

    const page = await context.newPage();
    await page.goto(`${site.origin}/`);
    await page.bringToFront();
    await composer.fill(
        'Read this page with browser_read_page, then click the "Run Action" button.',
    );
    await composer.press('Enter');

    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && !(await page.locator('#output p').count())) {
        const approve = chat.getByRole('button', { name: 'Approve', exact: true });
        if (await approve.isVisible()) {
            await approve.click();
        }
        await page.waitForTimeout(1000);
    }
    await expect(page.locator('#output p')).toHaveText('ACTION_DONE');
});
