# Third-Party Notices

OpenGrove includes or adapts the following third-party software. Components
identified below retain their own licenses and terms; they are not relicensed
under OpenGrove's Apache License 2.0.

## Anthropic Claude Agent SDK

OpenGrove desktop distributions bundle `@anthropic-ai/claude-agent-sdk` and
the matching platform-native Claude engine package. These Anthropic components
are proprietary software and are not covered by OpenGrove's Apache License 2.0.

Copyright Anthropic PBC. All rights reserved. Use is subject to the Anthropic
legal agreements referenced by the license files shipped with those packages.

Sources and terms:

- https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- https://code.claude.com/docs/en/agent-sdk
- https://code.claude.com/docs/en/legal-and-compliance
- https://www.anthropic.com/legal/commercial-terms

## Model Context Protocol ext-apps

OpenGrove uses `@modelcontextprotocol/ext-apps` version 1.7.5 and adapts
portions of its `basic-server-vanillajs` example in
`scripts/test-mcp-app-sandbox.mjs`. OpenGrove changes the example's handlers
and tool calls to exercise the OpenGrove HTTP bridge.

The upstream project is transitioning from the MIT License to the Apache
License 2.0. Its license notice states that new code and relicensed
contributions are Apache-2.0, while contributions whose authors have not
consented to relicensing remain MIT-licensed. The npm package metadata for
version 1.7.5 declares the package as MIT-licensed. Applicable upstream code
retains its original MIT or Apache-2.0 terms.

Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Apache-2.0 contributions are covered by OpenGrove's top-level `LICENSE` file.

Sources:

- https://github.com/modelcontextprotocol/ext-apps/tree/v1.7.5
- https://github.com/modelcontextprotocol/ext-apps/blob/v1.7.5/examples/basic-server-vanillajs/src/mcp-app.ts
- https://www.npmjs.com/package/@modelcontextprotocol/ext-apps/v/1.7.5

## shadcn/ui

The Avatar component structure in `web/src/components/ui/avatar.tsx` is adapted
from shadcn/ui and translated from Tailwind utilities to OpenGrove CSS tokens.

Copyright (c) 2023 shadcn

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/shadcn-ui/ui

## Avvvatars

OpenGrove uses the `avvvatars-react` package for deterministic character
fallback avatars.

Copyright (c) 2022 nusu

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/nusu/avvvatars

## Base UI

The local shadcn-style Avatar primitives use `@base-ui/react/avatar`.

Copyright (c) 2019 Material-UI SAS

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/mui/base-ui

## DiceBear Core and Notionists

OpenGrove uses DiceBear Core to generate deterministic employee avatars locally.
The DiceBear Core library is licensed under the MIT License. The Notionists
avatar artwork used by OpenGrove is distributed by DiceBear under CC0 1.0.

DiceBear Core copyright (c) 2026 Florian Körner

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Notionists artwork: CC0 1.0 Universal

To the extent possible under law, the creator has waived all copyright and
related or neighboring rights to the Notionists artwork.

Sources:

- https://github.com/dicebear/dicebear
- https://www.dicebear.com/styles/notionists/
- https://creativecommons.org/publicdomain/zero/1.0/

## Models.dev

OpenGrove includes a compact, release-time snapshot of public Provider and
model metadata from Models.dev.

Copyright (c) 2025 models.dev

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/anomalyco/models.dev
