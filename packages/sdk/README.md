# @opengrove/sdk

Generated JavaScript SDK for external consumers of the OpenGrove Host API.

The package is generated from `@opengrove/protocol` through the committed
OpenAPI 3.1 document. It is not used by OpenGrove's Web, desktop, or CLI
runtimes; those consumers use `@opengrove/client`, whose single transport owns
OpenGrove's runtime validation and error semantics.

```ts
import { OpenGroveApi } from "@opengrove/sdk";
import { createClient } from "@opengrove/sdk/client";

const client = createClient({
  baseUrl: "http://127.0.0.1:37371/api",
  headers: { "x-opengrove-token": process.env.OPENGROVE_BRIDGE_TOKEN! },
  throwOnError: true,
});
const sdk = new OpenGroveApi({ client });

await sdk.room.message.create({
  path: { roomId: "room-1" },
  body: { text: "Hello", targetIds: [], attachments: [] },
});
```

The same running Host exposes Skills and extensions, Routines, and Artifacts:

```ts
const inventory = await sdk.extension.extension.list();
const workflow = await sdk.routine.routine.create({
  throwOnError: true,
  body: {
    title: "Use a published Skill",
    steps: [{ toolId: "skill.invoke", input: { skill: "my-skill" } }],
  },
});
const result = await sdk.routine.routine.run({
  path: { routineId: workflow.data.routine.id },
});
const outputs = await sdk.artifact.artifact.list({ query: { type: "note" } });
```

Skill import/publish/republish/unpublish and deployment enable/disable/delete
reuse the Host's ownership checks. Inspect `result.warnings`: a successful
request can skip a protected or unsupported deployment. Changes refresh the
Host's Skill catalog for subsequent work without a restart.

Routine results include `summary.status`; HTTP success does not imply workflow
success. Execution can fail or pause for approval. Scheduling requires the Host
to remain running. Approval and question lists accept `runId` to select one
execution. These filters are for selection, not an authorization boundary.

Artifact lists return bounded summaries; use `artifact.artifact.get` to read
complete data. Delete and Skill deployment operations require `--yes` when
called through the OpenGrove CLI; `--dry-run` validates without sending a request.

These are OpenGrove product APIs. For a product-independent embedded runtime or
standalone Agent HTTP service, use [Agent Host](https://github.com/open-grove/agent-host).

Repository validation: `npm run test:product-interfaces` exercises the generated
Client, CLI and this external SDK against isolated local Hosts.
