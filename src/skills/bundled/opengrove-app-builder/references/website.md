# Independent website publication

Use this workflow when the user chooses **Publish as a website**. That request
authorizes preparation and review of the current App. Preserve its desktop
behavior and work only inside its App root.

## Common preparation, then judgment

1. Run `opengrove app web prepare <app-root>`. It preserves existing
   `opengrove.web.json`, or derives a static browser target from a manifest
   HTML entry in a dedicated directory. It does not execute arbitrary build
   commands. Read the findings and existing App build recipe.
2. If the output is already browser-compatible, proceed to review. Otherwise
   adapt only supported functionality: static browser code or existing HTTP
   APIs. Reuse the App's build system, browser state and data transformations.
   Keep reusable build commands in the App's scripts and document their order.
3. A CLI using `fetch` is usually a transport wrapper plus business logic.
   Extract its request construction, response conversion and validation into
   browser code. Replace process credentials, local-file caching and command
   invocation with the SDK below. Do not expose a shell/CLI execution endpoint.
4. Native execution, Agent runs, arbitrary local files and Python/FFmpeg are
   outside version 1. Record excluded features and show their availability in
   the browser. If the requested core workflow depends on them, report the
   blocker and leave it unpublishable. Do not silently remove functionality.
5. Run the existing documented build command, then
   `opengrove app web check <app-root>`. The declared output contains only the
   browser build, including its entry HTML; never point it at the App root,
   Workspace, source tree, dependency cache or private configuration.
6. Open `opengrove app web preview <app-root>` in an independent browser and
   test the included behavior. The preview serves an immutable snapshot on a
   separate loopback origin without a desktop bridge. Its SDK loads, but
   account/Cloud endpoints explicitly return an unavailable preview result.
   This alone cannot verify real HTTP permissions.
7. For HTTP Apps, test request shape, failure states, login transitions,
   active-account binding, business roles, ownership and pending writes using
   the intended API and appropriate test accounts. Retain unsent edits and
   explicit conflict handling. Clearly label synthetic fixtures and state
   which production checks remain unavailable. Do not claim missing API tests
   passed or fabricate a completed review.
8. After the final build, run `check` again and record a report with the exact
   `artifactSha256`, a meaningful `summary` and nonempty `checks` array:
   `opengrove app web review <app-root> <report.json>`.
   Review is an attestation of actual checks; it does not run them.
   Changes to output or access policy invalidate it.
9. Report the result in the App group. The user publishes through the panel;
   do not deploy during a review request.

Fix supported problems and repeat checks before recording the final review.
Never record a review solely to enable the Publish button. Include any testing
limits in the review summary so the publisher can assess them.

## Configuration

For an editor-facing browser target:

```json
{
  "schemaVersion": 1,
  "appId": "editorial-desk",
  "title": "Editorial desk",
  "mode": "http",
  "output": "website-dist",
  "entry": "index.html",
  "audience": { "mode": "roles", "roles": ["storyseed_editor", "editor", "admin"] },
  "permissions": ["editorial.read", "editorial.write"],
  "includedFeatures": ["Review the queue available to the signed-in editor"],
  "desktopOnlyFeatures": []
}
```

Use the real manifest ID. `mode` is `static` or `http`; static requires an
empty permissions list. Audience is `public`, `authenticated`, or `roles`
with one or more canonical role identifiers. The publisher selects the policy;
do not widen it during adaptation. Admin-only means `roles: ["admin"]`.

Permissions are read/write pairs: `story-seed`, `editorial`, `data`,
`agreement`, and `production`. Request only what the included features use.
Website admission does not grant business authority. For example, an editor's
invited-author ownership remains enforced by WW; displaying an administrator
button cannot grant administrator access.

## Browser SDK

The platform serves an ES module at `/_og/sdk.js`. Keep that import external
to the build. Browser bundlers can use a dynamic import with their documented
external-import mechanism, or a plain module script can import it directly.

```js
import { currentSession, login, request, draftsFor, download } from "/_og/sdk.js";

const session = await currentSession();
if (!session.authenticated || session.needsAuthorization) {
  // Show a sign-in action. Preserve drafts before navigating.
  signInButton.onclick = login;
} else {
  const subject = session.user.sub;
  const drafts = draftsFor(subject);
  // Use a verified business route and preserve its response envelope.
  const result = await request("/v1/review/novel-outlines");
  // Every write carries the identity that owns the pending change.
  await request("/v1/review/novel-outlines/" + outlineId + "/verdict", {
    method: "POST",
    expectedSubject: subject,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(verifiedVerdictPayload)
  });
  await drafts.save("pending-verdicts", JSON.stringify(pendingVerdicts));
  download("review.json", JSON.stringify(result), "application/json");
}
```

The endpoint and payload above illustrate the transport; inspect the actual
App/backend schema before using them. `request` returns the original JSON
envelope and throws `WebsiteRequestError` with HTTP status and response body.
Handle 401 by preserving state and offering login, 403 as insufficient access,
and 409 as account change or a business conflict. Login uses central consent;
browser code never receives an account-wide token. `logout` clears this
website's session; `session.authorizationsUrl` manages central grants/login.

`draftsFor(subject)` creates account-bound local draft read/save/remove methods.
It is browser-local persistence, not server synchronization or secure storage
from another user of the same browser profile. Pending writes still need App
validation, synchronization and conflict handling.
