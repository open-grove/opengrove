# App websites

An App website is an independently served browser build of explicitly selected
App functionality. It does not start a desktop Host, a Kernel, or native commands.
The desktop App and its persistent Workspace keep their existing lifecycle.

## Supported functionality

Version 1 supports static browser pages and browser code using existing Cloud
APIs. App-specific HTTP requests and data transformations may be extracted from
a CLI into a browser adapter. Native commands, Agent execution, unrestricted
local files, and Python/FFmpeg pipelines are unsupported. A mixed App declares
which functionality is included and which remains desktop-only.

The platform provides repeatable preparation, a browser SDK, build validation,
artifact packaging, publication, status and rollback. App Builder reviews the
prepared result and repairs App-specific browser code where possible. Successful
adaptations remain in the App and are reused on subsequent builds.

## Publication workflow

The Publish action appears immediately to the left of the App Builder button
in the App title bar. Publish to App Store opens the existing store publication
page for the current App. Publish as independent website opens a separate
website panel, where the publisher selects its audience before preparation and
review. Website audience and App Store visibility are independent.

1. Prepare a browser target and report unresolved dependencies.
2. Build a runnable preview and run deterministic checks.
3. App Builder reviews the included functionality, API permissions and behavior.
   A failed check returns to repair; unsupported requirements stay explicit.
4. Record the review against the exact artifact digest. Any output or website
   configuration change invalidates the review.
5. Upload the reviewed artifact and activate its immutable release. An identical
   request is safe to retry; a different artifact cannot replace a release.
6. Return the stable website URL only after activation succeeds. Rollback selects
   a previously accepted release without rebuilding it.

Website publishing remains an administrator operation. Review is a quality
decision, not an authorization credential; the publishing service independently
authenticates the publisher and validates the artifact and access policy.

## Browser target

The App keeps its website configuration and browser source outside its Workspace.
The output directory contains only website files. Build instructions remain in
the existing App build recipe; browser adapters must not import Node modules or
depend on loopback services. The website archive never contains the Workspace,
credentials, native executables, symlinks or files outside the declared output.

The browser SDK provides login, current identity, authorized HTTP requests,
per-account draft storage and downloads. Apps retain their business-specific
validation, conflict handling and synchronization rules. In particular, pending
writes are user state and must not be treated as disposable cached responses.

## Audience and business authorization

Website audience is independent of App Store visibility:

- `public`: the page is available anonymously. Protected API actions still
  require login and the corresponding authorization.
- `authenticated`: an active OpenGrove account is required.
- `roles`: an active account must have at least one selected role. Admin-only
  uses the `admin` role; admin access is not silently added to another policy.

The website entry and asset routes enforce the current audience policy.
Cloud APIs remain responsible for object and action permissions. A website
policy never grants authority to read another user's data or perform an action.

## Login and hosting boundary

Websites use separate browser origins and host-only sessions. A shared platform
gateway serves the static assets and forwards authorized API requests; it does
not execute App server code. The central authorization service reuses account
login and issues a single-use authorization code bound to an exact callback,
client and S256 PKCE challenge. Users see the App and requested permissions.

Delegated credentials are limited to the App's approved permissions and the
user's current business permissions. They are never equivalent to unrestricted
desktop account credentials. Access revocation and account-role changes are
checked by the services. The browser SDK receives identity and results, not
platform publishing credentials or a global administrator token.

Deployment requires an explicitly configured website domain, HTTPS, central
login and private artifact storage. Missing configuration fails publication;
local previews are never described as deployed websites.

## Tooling

Local tooling uses `opengrove app web prepare|check|review|preview <app-root>`. Preparation checks existing browser output; App Builder reuses documented build commands before review. [The builder guide](../../src/skills/bundled/opengrove-app-builder/references/website.md) describes configuration and the browser SDK.

Host operations are also available as `opengrove app website get|prepare|configure|publish|activate --app-id <id>`. Use `--help` for typed arguments. High-risk CLI publication/activation requires `--yes`, with `--dry-run` available to inspect the request first. Publication takes the reviewed artifact digest and last observed published digest (empty for the first publication).

Login uses OpenID Connect Authorization Code with S256 PKCE. A protocol library embedded in the central account service supplies authorization, ID tokens and discovery; the gateway uses its matching client to verify signature, issuer, audience, expiry and nonce. No separate identity-service deployment is required. Website cookies contain only encrypted, short-lived, scoped access credentials. ID tokens and website access tokens cannot be used as unrestricted account credentials. Live roles and object permissions remain the responsibility of the existing services.
