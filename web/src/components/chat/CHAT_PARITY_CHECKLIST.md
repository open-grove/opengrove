# Chat Parity Smoke Checklist

Use after changing kernel or room run rendering.

- Kernel running turn: process timeline opens by default while activity is active.
- Room and mounted-app chat running turns: process timeline is collapsed by default, shows a non-empty summary, and stays above the answer.
- Room and mounted-app chat expanded process details: keep one outer run summary only; inner activity rows must not render a second activity summary toggle.
- Claude-native tools: `claude.Bash`, `claude.Grep`, `claude.Glob`, `claude.Edit`, `claude.Write`, `claude.WebFetch`, and `claude.TodoWrite` render semantic activity labels rather than raw `claude.*` ids.
- Room intervention turns: pending approval, question, or choice-form opens the process timeline by default.
- Queued follow-up: attachments, context, requested skill, model, kernel, app id, effort, speed, budget, access mode, and vault file context survive queueing and replay.
- Guide success removes the queued item.
- Guide failure shows a visible failed state with the backend reason.
- Guide before run id is ready shows a visible not-ready state.
- Resource links: file references use explicit Markdown links (e.g. `[web/src/app.tsx](web/src/app.tsx#L12)`), never inline code. Inline code (`` `foo.py` ``, `` `path/x.md` ``, `` `https://...` ``, `` `npm run check` ``) renders as plain `<code>` with no `data-resource-reference`. Shell commands in Markdown link hrefs also stay inline code, never resources.
- Final-answer Markdown: GFM tables render as real `<table>` (no bare `|---|` separators); table cells reuse the chat inline renderer, so inline code inside cells is also plain `<code>`.
- Resource cards: artifact cards with actionable `uri`, `imageUri`, or `path` render open/more actions through the shared resource model.
- Resource preview: kernel, room, and mounted-app chat surfaces share the same read-only preview panel; mounted-app resources use existing app file/raw routes.
- Memory citations: raw `<oai-mem-citation>` blocks are suppressed from answer text until structured citation UI ships.
