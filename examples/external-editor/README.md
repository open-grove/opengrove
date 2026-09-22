# External editor example

[中文](README.zh-CN.md)

This plain Node.js product uses a real Agent through the public SDK. It creates
its own `project/timeline.json`, gives the Agent a product-owned rename tool and
asks the user before changing the timeline. It is not an OpenGrove App.

1. Build local archives at the repository root: `npm run pack:local`.
2. Install/start the Host as described in [Local integration](../../docs/reference/LOCAL_INTEGRATION.md).
3. In this directory, run `npm install`, then set `OPENGROVE_BRIDGE_URL`,
   `OPENGROVE_BRIDGE_TOKEN` and `AGENT_MODEL` to your Host and supported model.
4. Run `npm start`. Ask to rename the timeline, approve or reject the proposed
   change, and ask a follow-up in the same session.

`EDITOR_WORKSPACE` selects an absolute project directory. `EDITOR_SESSION_ID`
reuses an existing conversation when its runtime binding matches. The default
Kernel is Codex with its native login; `AGENT_PROVIDER` can select a configured
Provider. The example token authorizes a local owner and must stay private.

The demo's JSON receipt avoids reapplying the last completed call during an
ordinary reconnect. Production integrations should persist an atomic operation
receipt and enforce their own business permissions. Native approvals and
questions are rendered with basic text prompts; this demo does not supply a
complete renderer for every Kernel's structured question form.

## Standalone web UI

After installation and Host startup, run `npm run web` in this directory and open
the printed local URL (default `http://127.0.0.1:37430`). `EDITOR_PORT` changes the
port, `EDITOR_WORKSPACE` selects an absolute project directory, and
`OPENGROVE_BRIDGE_URL` selects the Host. Choose a configured Kernel/model/Provider;
the existing project session retains its original binding.

Request a rename, reload while confirmation is pending, then approve the same
task and continue the conversation. Project state and task history survive page
reloads. Disconnecting observation leaves the task running; Cancel requests
actual cancellation. Native questions support common question lists and text
answers, not every possible structured form.

The token stays in the local companion process. The page makes same-origin
requests to it; the companion proxies only the Host operations used by this
example. Product actions are verified against the pending call and current
project, and the mutation is persisted atomically with its receipt. Multiple
tabs retrying the same call do not apply the change again. This remains a local
single-owner example, not a multi-user web deployment.

`npm start` runs the original terminal example; `npm run web` runs the web UI.
