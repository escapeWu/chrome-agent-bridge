# Third-party notices

## OpenClaw

Chrome Agent Bridge's semantic page-control contract and interactive role set were informed by the OpenClaw Browser plugin at commit [`3d707a9b963b91134d01b204638f87841a50787b`](https://github.com/openclaw/openclaw/tree/3d707a9b963b91134d01b204638f87841a50787b/extensions/browser).

OpenClaw is licensed under the MIT License:

```text
MIT License

Copyright (c) 2026 OpenClaw Foundation

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
```

The complete OpenClaw license is available at [github.com/openclaw/openclaw/blob/main/LICENSE](https://github.com/openclaw/openclaw/blob/main/LICENSE).

OpenClaw is not bundled as a runtime dependency. Chrome Agent Bridge retains its own MCP, Native Messaging, authentication, and CDP transport implementation.

## Analysis runtime dependencies

Chrome Agent Bridge uses the following MIT-licensed packages for clean-room local analysis:

- Acorn, copyright (C) 2012-2022 by various contributors.
- acorn-walk, copyright (C) 2012-2020 by various contributors.
- `@jridgewell/trace-mapping`, copyright 2024 Justin Ridgewell.
- `@jridgewell/resolve-uri`, copyright 2019 Justin Ridgewell.
- `@jridgewell/sourcemap-codec`, copyright 2024 Justin Ridgewell.

Their common license terms are:

```text
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
```
