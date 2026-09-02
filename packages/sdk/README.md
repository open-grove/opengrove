# @opengrove/sdk

Generated JavaScript SDK for external consumers of the OpenGrove Host API.

The package is generated from `@opengrove/protocol` through the committed
OpenAPI 3.1 document. It is not used by OpenGrove's Web, desktop, or CLI
runtimes; those consumers use `@opengrove/client`, whose single transport owns
OpenGrove's runtime validation and error semantics.

```ts
import { OpenGroveApi } from "@opengrove/sdk";
import { createClient } from "@opengrove/sdk/client";

const client = createClient({ baseUrl: "http://127.0.0.1:37371/api" });
const sdk = new OpenGroveApi({ client });

await sdk.room.message.create({
  path: { roomId: "room-1" },
  body: { text: "Hello", targetIds: [], attachments: [] },
});
```
