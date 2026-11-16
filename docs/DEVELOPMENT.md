# Development

## Set up

Node.js 22 or newer and Chrome 116 or newer.

```bash
npm ci                 # install exactly what package-lock.json lists
npm run dev            # watch build, reloads the extension on change
npm run build          # .output/chrome-mv3, load it with "Load unpacked"
```

A build of your own carries the public key in `wxt.config.ts`, so its id is
always `ogglimafigjflmiccojhjlljohnoabph`. For the full loop you need an Odoo
with `muk_ai_browser` and an AI provider; see the README's Set up section.

## Checks

```bash
npx tsc --noEmit -p .  # types
npm run lint           # eslint
npm run format:check   # prettier
npm test               # unit tests (vitest, jsdom)
npm run e2e            # Playwright against the build and a fake Odoo
```

GitLab runs the first four and the build on every push, GitHub on every pull
request.

`npm run e2e` loads the build into Chromium with all sites granted. Set
`HEADED=1` to watch it. `e2e/live.spec.ts` runs against a real Odoo when
`ODOO_URL` (one database) and `PAIR_CODE` (a fresh code from
`<odoo>/muk_ai_browser/connect`) are set.

## Trusted input

Tool calls with `trusted: true` send real input events through the Chrome
debugger protocol, for pages that ignore synthetic events. That needs the
`debugger` permission, which Chrome does not allow as optional, so the
published builds do not request it and answer such calls with
`trusted_input_unavailable`. Add `debugger` to `permissions` in
`wxt.config.ts` for a build of your own that has it.

## Layout

- `entrypoints/`: what WXT builds into the extension: the service worker,
  the side panel, the options page and the content scripts.
- `lib/`: the logic, each module with unit tests in `tests/unit/`: the Odoo
  client, attaching and polling, tool routing and the runner, perception, the
  page actions, keys, screenshots, trusted input and the message types.
- `lib/playwright-aria/`: the accessibility-tree code adapted from
  Microsoft Playwright (see `NOTICE`); it is excluded from linting.
- `e2e/`: Playwright tests and their fake Odoo.
- `store/`: the privacy policy and the Chrome Web Store images.
- `docs/`: these pages and the README screenshots.

How the parts work together, the Odoo routes and the messages are in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Code style

- Prettier (4 spaces, single quotes, 88 columns) and ESLint decide the
  format; no inline suppressions.
- Every function and class has a JSDoc with a one-line summary;
  `@param` and `@returns` on exported functions. Comments describe what the
  code does now, never its history. The only other comments are the
  `// ----` section headers.
- Plain ASCII in code and in user-facing strings; write a non-ASCII
  character as a `\u` escape, as the middle dot in the card does.
- Tests cover behaviour through real entry points, as tables where cases are
  alike.

## Releasing

1. Bump `version` in `package.json` and run `npm install --package-lock-only`.
2. Commit, push and tag `vX.Y.Z` on the main branch.
3. The GitLab pipeline checks the tag and mirrors it to GitHub, where the
   release workflow builds `muk-ai-browser-extension-X.Y.Z-chrome.zip` and
   publishes it as a GitHub release.
4. For the Chrome Web Store, build `npm run zip:store` (without the key the
   store rejects) and upload it in the developer dashboard.

The source of truth is `browser-extensions/muk_ai_browser_extension` on
gitlab.mukit.at. GitHub (`muk-it/muk-ai-browser-extension`) is a mirror of
its main branch and version tags without the GitLab pipeline file and the
internal store notes; pull requests on GitHub are applied on GitLab.
