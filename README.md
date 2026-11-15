# MuK AI Browser

<img src="public/icon/128.png" alt="" width="64" align="right">

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-MuK_AI_Browser-33627E?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/fecogbhcchendbojonbojofkiehdacne)
[![Odoo app](https://img.shields.io/badge/Odoo-muk__ai__browser-714B67?style=flat-square)](https://apps.odoo.com/apps/modules/muk_ai_browser)
[![YouTube demo](https://img.shields.io/badge/YouTube-demo-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://youtu.be/ZcIvjovoFtg)
[![License Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue?style=flat-square)](LICENSE)
[![Website mukit.at](https://img.shields.io/badge/Website-mukit.at-243742?style=flat-square)](https://www.mukit.at)

A Chrome extension that lets a MuK AI agent from your Odoo read and act on the
web pages you work on: read a page, find elements, click, type, fill forms,
navigate, open tabs and take screenshots. Chrome's side panel shows your
Odoo's own MuK AI chat; the agent, its approvals, the per-site rules and the
audit trail live in your Odoo.

It requires the **MuK AI Browser** Odoo app (`muk_ai_browser`), free under
LGPL-3. Built with [WXT](https://wxt.dev), TypeScript and React. Licensed
under Apache-2.0 (see `LICENSE`); the accessibility-tree code is adapted from
Microsoft Playwright (see `NOTICE` and `lib/playwright-aria/`).

## Install and set up

1. Install the `muk_ai_browser` app in your Odoo.
2. Add the extension from the
   [Chrome Web Store](https://chromewebstore.google.com/detail/fecogbhcchendbojonbojofkiehdacne),
   or build it yourself: `npm install`, `npm run build`, then in
   `chrome://extensions` enable Developer mode, click **Load unpacked** and
   choose `.output/chrome-mv3`. A self-built extension carries a fixed public
   key, so its id is always `ogglimafigjflmiccojhjlljohnoabph`.
3. The options page opens and walks through three steps:
    1. **Odoo address**: `https://...` (`http://` only for `localhost`),
       resolving to one database. Saving asks Chrome for access to that site.
    2. **Connect**: opens `<odoo>/muk_ai_browser/connect`. Log in there; the
       extension reads the one-time code, pairs, and the tab closes by
       itself while the side panel continues. Elsewhere, paste the code into
       the side panel.
    3. **Allow on all sites** (optional): lets the agent act on any page and
       shows the MuK AI tab on pages (can be turned off).

## Using it

Open the side panel with the toolbar button, or with the MuK AI tab on the
right edge of a page (drag it up or down; it hides while the panel is open
and never shows on your Odoo). The panel shows the MuK AI chat of your Odoo,
with everything installed there: agents, tools, approvals, skills and voice.
Before loading it the extension asks Odoo whether you are logged in, and
shows **Log in to Odoo** or **Odoo is not reachable** until it is ready.

The chat open in the panel is the one the agent acts for. While it is not
working, the agent follows the tab you look at; the bar above the chat names
that site (with a pulsing dot while the agent works), and clicking it brings
the tab to the front. Tabs the agent opens join a tab group named "MuK AI".

## Permissions

| Permission                          | Why                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `sidePanel`                         | The Odoo chat is shown in Chrome's side panel.                                                 |
| `storage`                           | The Odoo address, the device key, the chat id and the launcher preferences.                    |
| `scripting`                         | Injects the page tools when the agent acts; registers the pairing reader and the launcher.     |
| `activeTab`                         | Lets the agent act on the tab where you clicked the toolbar button, without all-site access.   |
| `tabs`, `tabGroups`                 | Finds the agent's tab, opens and closes its own tabs and groups them as "MuK AI".              |
| `alarms`                            | Resumes polling Odoo after Chrome suspends the extension, only while a chat is active.         |
| Your Odoo's address (asked on save) | Talks to your Odoo, checks the login and reads the pairing code on its connect page.           |
| All sites (optional)                | Lets the agent read and act on any page, and shows the MuK AI tab. Otherwise only `activeTab`. |

**Trusted input** (real input events through the debugger protocol) needs the
`debugger` permission, which Chrome does not allow as optional. This build
does not request it and answers `trusted: true` calls with
`trusted_input_unavailable`; add `debugger` to `permissions` in
`wxt.config.ts` to enable it.

## Privacy

The extension talks only to the Odoo you configured. It sends the chat id, the
origin of the agent's tab, the device label (e.g. `Chrome on Windows`) and the
results of the actions the agent asks for (page outline, screenshots, URL and
title). It reads pages only when the agent asks, only in the agent's tab, never
types into password, payment-card or one-time-code fields and never uploads
files. Your Odoo decides per site whether the agent may act, must ask, or is
blocked.

## Develop

```bash
npm run build          # .output/chrome-mv3
npm run zip:store      # Chrome Web Store package, without the id key (store/LISTING.md)
npm run dev            # watch build with reload
npm test               # unit tests (vitest, jsdom)
npm run lint           # eslint
npm run format:check   # prettier
npx tsc --noEmit       # types
npm run e2e            # Playwright against the build and a fake Odoo
```

`e2e/live.spec.ts` runs against a real Odoo when `ODOO_URL` and `PAIR_CODE`
are set.

- `lib/`: logic with unit tests: Odoo client, attach and poll, tool routing
  and runner, perception, page actions, screenshots, trusted input, messages.
- `entrypoints/`: wiring. `background.ts` (service worker: pairing, login
  check, polling, launcher visibility), `sidepanel/` (onboarding and the
  embedded chat), `options/`, `content/` (page tools, injected on demand),
  `launcher.content.ts` and `pairing.content.ts` (registered at runtime).
- `store/`: Chrome Web Store listing, privacy policy and images.

The Odoo side of the protocol (pairing, polling, tool results) lives in the
`muk_ai_browser` app, in `controllers/browser.py`.
