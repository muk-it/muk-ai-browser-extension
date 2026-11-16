# Architecture

MuK AI Browser has two halves. The **Odoo app** `muk_ai_browser` runs the
agent: the conversation, the model calls, the approvals, the site rules and
the log. The **extension** is its actuator in the browser: it shows the Odoo
chat in Chrome's side panel and runs the browser tools the agent calls. The
extension never talks to an AI model and holds no rules of its own.

```
 Chrome                                              Odoo
+---------------------------------+                +-------------------------+
| side panel                      |                | muk_ai_browser          |
|   card bar, agent bar           |  card, check   |   routes /muk_ai_browser|
|   <iframe> Odoo chat  <---------+----------------+-> /ai_browser/chat      |
| service worker                  |                |   gate: site rules,     |
|   pairing, polling, runner  <---+-- events ------+   plan, approvals       |
|                             ----+-- results ---->+   muk_ai agent loop     |
| content scripts                 |                +-------------------------+
|   page tools (on demand)        |
|   launcher, pairing reader      |
+---------------------------------+
```

## Parts of the extension

| Part           | Where                                       | Does                                                                                                                              |
| -------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Service worker | `entrypoints/background.ts`                 | Pairs, attaches to the chat, polls Odoo, runs the tools, keeps the status, fetches the card, owns the context menu and the alarm. |
| Side panel     | `entrypoints/sidepanel/`                    | Onboarding, the card bar, the agent bar and the Odoo chat in an iframe.                                                           |
| Options page   | `entrypoints/options/`                      | The Odoo address, Connect and the all-sites permission.                                                                           |
| Page tools     | `entrypoints/content/`, `lib/actions.ts`    | Injected into the agent's tab on the first tool call; read, find, click, type, fill, select, scroll, wait, link and upload.       |
| Perception     | `lib/perception.ts`, `lib/playwright-aria/` | The accessibility snapshot with stable refs (`[ref=e12]`) the tools act on.                                                       |
| Runner         | `lib/runner.ts`, `lib/tools.ts`             | Routes a call to the page, the tabs, the screenshot, the file or the trusted-input executor.                                      |
| Launcher       | `entrypoints/launcher.content.ts`           | The MuK AI tab on the right edge of pages, registered only with the all-sites permission.                                         |
| Pairing reader | `entrypoints/pairing.content.ts`            | Reads the one-time code on the Odoo connect page, registered only for the configured Odoo.                                        |
| Odoo client    | `lib/odoo.ts`                               | The HTTP calls, their errors and the check whether the Odoo has the app.                                                          |

## Odoo routes

Every route except `/pair`, the connect page and the chat is authenticated
with the browser's device key as a bearer token.

| Route                     | Method | Purpose                                                                                       |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `/muk_ai_browser/connect` | GET    | Page for a logged-in user with a one-time pairing code in a `<meta>` tag.                     |
| `/muk_ai_browser/pair`    | POST   | Exchanges the code for a device key, shown once.                                              |
| `/muk_ai_browser/unpair`  | POST   | Deletes the device key.                                                                       |
| `/muk_ai_browser/session` | POST   | Attaches this browser to a chat.                                                              |
| `/muk_ai_browser/events`  | GET    | Reports the tab's origin and the agent's tabs; returns the chat state and pending actions.    |
| `/muk_ai_browser/result`  | POST   | Returns the result of an action. A saved file becomes an attachment before the model sees it. |
| `/muk_ai_browser/card`    | GET    | The company in Odoo behind the site of a page.                                                |
| `/muk_ai_browser/file`    | GET    | The attachment of a pending, approved upload.                                                 |
| `/muk_ai_browser/whoami`  | GET    | The user of the device key.                                                                   |
| `/ai_browser/chat[/<id>]` | GET    | Redirects to the Odoo chat that the side panel frames, a new one without an id.               |

## Flows

**Pairing.** Connect opens the Odoo connect page. The pairing reader takes the
code from the page and hands it to the service worker, which checks that the
page is the configured Odoo's connect page, posts the code to `/pair`, stores
the device key and closes the tab. A code can also be pasted into the side
panel.

**Checking the Odoo.** Before the panel frames the chat, the service worker
asks whether the Odoo has the app (`/ai_browser/chat` must redirect, a 404
means the app is missing) and whether a user is logged in. The panel shows the
chat, a login card, "Odoo is not reachable" or "The app is missing in Odoo".

**Attaching and polling.** The framed chat posts its id to the panel, and the
service worker attaches to it. While the panel is open or the agent works, it
polls `/events`: with the origin of the agent's tab and its tab list, so that
Odoo judges every call on the right site. Each pending action runs once; its
call id is remembered, so a poll after a restart answers it as lost instead
of running it again. A 401 forgets the pairing, a lost browser session is
attached again, and an Odoo that does not answer is shown as unreachable.

**Running an action.** Odoo decides first: a blocked site is refused,
writing actions ask on a site set to ask, outside an approved plan, on a form
submit, on a risky word and on every upload. The extension then refuses an
action whose tab has moved to another origin since Odoo judged it, never
types into password, payment card or one-time code fields, and does not run a
tool again when the page navigated while it ran.

**The card.** For the agent tab's site the service worker asks `/card` once
per site, and again after the agent worked. The panel draws the company with
its details and the prompts Odoo offers; a prompt goes into the chat's
composer by `postMessage`.

**Files.** `browser_save_file` downloads the file in the service worker with
the user's cookies for that site and posts it as the result; Odoo stores it
on the record. `browser_upload_file` fetches the approved attachment from
`/file` and the page tool puts it into the file field.

## Messages

| From, to               | Message                                                                                      | Meaning                                       |
| ---------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Odoo frame -> panel    | `muk_ai_browser.chat`                                                                        | The chat the frame shows.                     |
| Odoo frame -> panel    | `muk_ai_browser.show`                                                                        | Show an Odoo record in the agent's tab group. |
| Panel -> Odoo frame    | `muk_ai_browser.compose`                                                                     | Put a text into the chat's composer.          |
| Panel -> worker (port) | `panel/open`, `panel/attach`, `panel/show`, `panel/focus-tab`, `panel/pair`, `panel/connect` | Panel requests.                               |
| Worker -> panel (port) | `sw/status`, `sw/compose`                                                                    | The status, and text from the context menu.   |

Frame messages are accepted only from the framed window and the configured
Odoo origin on one side, and from the extension's origin on the other.
