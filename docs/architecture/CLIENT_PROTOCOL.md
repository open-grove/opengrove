# Client and protocol boundary

OpenGrove exposes Host capabilities through two public workspace packages:

- `@opengrove/protocol` is the environment-neutral source of truth for Host
  operations. Each operation explicitly owns its stable id, summary, HTTP
  method, path template, risk classification, path params, query params,
  request body, successful response, and declared error responses.
- `@opengrove/client` executes those operations. It owns URL construction,
  request and response validation, error normalization, and the generated typed
  domain API used by Web, desktop, CLI, and integrations.

The dependency direction is fixed:

```text
Web / Desktop / CLI / integration
              |
              v
      @opengrove/client ------> @opengrove/protocol <------ Host routes
```

`@opengrove/protocol` must not perform I/O or import Host implementation code.
`@opengrove/client` must not read browser storage, environment variables, or
desktop APIs. Each consumer supplies its base URL, credentials, and headers at
its adapter boundary. The package-boundary check enforces these import rules.

## Operation shape

An operation never infers query parameters from fields left over after path
substitution. The wire locations are explicit:

```ts
defineHostOperation({
  id: "room.message.create",
  summary: "Send a Room message",
  description: "Send a user message and schedule addressed Employees.",
  method: "POST",
  path: "/rooms/{roomId}/messages",
  risk: "write",
  params: roomMessageParams,
  query: roomMessageQuery,
  body: roomMessageBody,
  success: { status: 200, body: roomMessageResponse },
  errors: [{ status: 404, body: bridgeErrorResponse }],
});
```

Omit a section when the operation does not use it. A successful response with
no `body` represents an empty response. Streaming, multipart, and binary
operations require an explicit transport extension before migration; they must
not be disguised as JSON operations.

The Host validates the same request and response schemas that the Client uses.
An undeclared status or a payload that does not match its declared schema is a
contract violation, not a successful best-effort parse.

## Catalog and generated Client

`hostOperationGroups` organizes the Protocol as group, resource, and operation:

```text
room
  message
    create
```

Canonical operation ids use singular product/resource identities and a stable
method: `room.message.create`. Public Client names are a separate presentation
layer and use natural resource namespaces:

```ts
client.rooms.messages.create(...)
```

`compileHostProtocol` validates the source catalog once and produces the
environment-neutral Protocol IR. The compiler owns path parsing, flattened
input fields, requiredness, JSON Schema projection, response statuses, and
collision checks. Generators consume this IR; they must not inspect Zod internals
or execute request-time defaults and transforms while generating code.
The compiler and compiled catalog have dedicated package entry points; runtime
Client consumers do not load or execute the compiler.

`packages/client/client-map.json` contains only the naming differences between
the canonical catalog and the public Client. `npm run generate:host-client`
reads the compiled Protocol IR and writes the typed Client resource tree.
`npm run check:client-generated` fails when the committed generated output is
stale or when the map refers to an operation that no longer exists.

Do not hand-write a second resource method in the Client. A new operation is
added to the Protocol catalog, given any necessary public naming override, and
then generated.

## CLI projection

The Protocol catalog supplies capability facts to the future CLI projection:

- stable operation identity and hierarchy;
- input and output schemas;
- summary and description;
- risk classification.

CLI-only behavior stays outside the Protocol. Command aliases, shortcuts,
examples, identity selection, policy, confirmation gates, dry-run rendering,
and output formatting belong to the CLI package. A shortcut or workflow calls
the generated Client instead of assembling Bridge URLs.

This allows both a predictable raw operation and a friendlier shortcut to use
the same implementation:

```text
opengrove room message create ...
opengrove room send ...
```

## Naming and risk rules

- Keep product terms defined by OpenGrove: Host, Bridge, Kernel, Adapter, Room,
  App, Employee, Skill, Routine, Memory, and Artifact.
- Public packages describe their responsibility (`protocol`, `client`), not an
  implementation mechanism such as `api-manager` or `fetch-utils`.
- Protocol ids, public Client namespaces, and ergonomic CLI shortcuts are
  related but intentionally not forced to use the same grammatical form.
- Risk uses the closed taxonomy `read`, `write`, or `high-risk-write`. Unknown
  or missing values must fail closed when CLI policy enforcement is added.
- Consumer code must not assemble Host route strings after its operation has
  migrated to the Client.

The existing `@opengrove/agent-protocol` remains the home of Agent, Kernel, A2A,
and Room-context contracts. Its generic Bridge contract export is a temporary
compatibility re-export from `@opengrove/protocol`; new Host operations belong
in `@opengrove/protocol`.

## Migration rule

Migrate one vertical operation at a time by adding its explicit Protocol
definition, registering a typed Host operation handler, regenerating the
Client, and replacing one real consumer call. Business logic can remain in its
existing module, but the route boundary must consume `context.input.params`,
`context.input.query`, and `context.input.body`; it must not parse the same URL
or body again.

An operation is complete only when the shared contract is registered by the
Host route, generated into the Client, used by at least one real consumer,
covered by contract and Client tests, and included in packaged runtime checks.
Old generic request helpers shrink as operations move; do not add another one.
