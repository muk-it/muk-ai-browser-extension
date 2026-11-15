import { test, expect, type Page } from '@playwright/test';
import { type Launched, type Served, launch, serve } from './helpers';

/**
 * Launcher e2e: with "all sites" granted, the service worker registers the
 * launcher on every page. It is a tab on the right edge that can be dragged
 * (remembered per site), follows the "Show the MuK AI tab on pages" option,
 * opens the side panel and hides while that panel is open.
 */

let browser: Launched;
let site: Served;

test.beforeAll(async () => {
    browser = await launch();
    site = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Plain page</title><h1>Plain page</h1>');
    });
});

test.afterAll(async () => {
    await browser?.close();
    await site?.close();
});

/**
 * Open the plain page and return it with its launcher.
 *
 * @returns The page and the launcher button.
 */
async function openPage(): Promise<{
    page: Page;
    launcher: ReturnType<Page['locator']>;
}> {
    const page = await browser.context.newPage();
    await page.goto(`${site.origin}/`);
    return { page, launcher: page.getByRole('button', { name: 'Open MuK AI' }) };
}

test('registers the launcher on all sites once they are granted', async () => {
    await expect
        .poll(() =>
            browser.worker.evaluate(async () =>
                (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
            ),
        )
        .toEqual(['muk-ai-launcher']);
});

test('sits on the right edge, drags vertically and remembers the spot', async () => {
    const { page, launcher } = await openPage();
    await expect(launcher).toBeVisible();
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const box = await launcher.boundingBox();
    expect(box).toMatchObject({ width: 28, height: 64 });
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(viewport.width);
    expect(Math.abs((box?.y ?? 0) + 32 - viewport.height / 2)).toBeLessThan(2);

    const x = (box?.x ?? 0) + 14;
    await page.mouse.move(x, viewport.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, viewport.height * 0.25, { steps: 5 });
    await page.mouse.up();
    await page.reload();
    await expect
        .poll(async () => (await launcher.boundingBox())?.y ?? 0)
        .toBeLessThan(viewport.height * 0.25);
    await page.close();
});

test('follows the option to show the tab on pages', async () => {
    const { page, launcher } = await openPage();
    await expect(launcher).toBeVisible();
    const options = await browser.context.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    const option = options.getByLabel('Show the MuK AI tab on pages');
    await expect(option).toBeChecked();
    await option.uncheck();
    await expect(launcher).toBeHidden();
    await option.check();
    await expect(launcher).toBeVisible();
    await options.close();
    await page.close();
});

test('opens the side panel and hides while it is open', async () => {
    const { page, launcher } = await openPage();
    const sidePanels = () =>
        browser.worker.evaluate(async () => {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: [chrome.runtime.ContextType.SIDE_PANEL],
            });
            return contexts.map((context) => context.documentUrl);
        });
    expect(await sidePanels()).toEqual([]);
    await launcher.focus();
    await page.keyboard.press('Enter');
    await expect
        .poll(sidePanels)
        .toEqual([expect.stringMatching(/\/sidepanel\.html$/)]);
    await expect(launcher).toBeHidden();
    await page.close();
});
