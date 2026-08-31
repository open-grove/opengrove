# MCP App UI

Use `ui.surface: "view"` for every new custom App UI and put its transport/security contract under `ui.view`. Keep normal framework source in the App, bundle the browser result to the declared entry, and communicate with the Host only through the MCP Apps protocol. The HTML resource is a build artifact and protocol envelope, not the whole App or a restriction to hand-written HTML.

## Manifest

```json
{
  "ui": {
    "surface": "view",
    "workspace": "workspace",
    "view": {
      "protocol": "mcp-app",
      "entry": "ui/index.html",
      "tools": [
        "opengrove.app.workspace.list",
        "opengrove.app.workspace.read"
      ],
      "csp": {
        "connectDomains": [],
        "resourceDomains": [],
        "frameDomains": [],
        "baseUriDomains": []
      }
    }
  },
  "workspace": { "path": "workspace" }
}
```

Choose only supported per-App tools:

- `opengrove.app.workspace.list`
- `opengrove.app.workspace.read`
- `opengrove.app.workspace.write`
- `opengrove.app.flows.list`
- `opengrove.app.command.run`

`opengrove.app.command.run` accepts a `commandId` declared in `capabilities.cli`; it never accepts an arbitrary executable. Omit write and command tools unless the UI needs them.

## View rules

- Use `@modelcontextprotocol/ext-apps` for production View code and bundle dependencies into the entry HTML.
- Connect through `PostMessageTransport`; call Host-proxied tools with `App.callServerTool` / `tools/call`.
- Do not fetch `/api`, read Host cookies, assume a Host DOM, or depend on OpenGrove-specific iframe details.
- Keep CSP lists empty by default. Add only HTTPS origins required by the App. Host and sandbox origins are always removed from network grants.
- Never request or require `allow-same-origin`.
- Do not switch a setup App to `surface: "view"` until the entry exists and a real build has passed validation.
- Treat legacy `ui.kind: "custom"` as reserved and unsupported; it is not an alias for this View surface.

## Verification

Run:

```bash
opengrove app validate <app-root>
opengrove app report <app-root>
```

Then prove one allowed tool succeeds, one omitted tool is rejected, path traversal is rejected, the View initializes through a standard MCP Apps Host, and the OpenGrove Host accepts a View built with the upstream SDK.
