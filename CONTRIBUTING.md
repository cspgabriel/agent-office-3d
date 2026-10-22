# Contributing

Thanks for helping! A few notes to keep the project easy to work on:

- **No build step, no dependencies.** Server is plain Node.js (ESM, Node 20+); the frontend is vanilla JS modules plus three.js from a CDN. Please keep it that way unless there is a strong reason.
- **Try it without Multica:** `DEMO=1 npm start`. Demo mode fakes the `multica` CLI with fictional agents.
- **Tests:** `npm test` (built-in `node:test`). Server modules receive the CLI as a function, so tests pass a fake one — no workspace needed. New server modules should follow the same pattern (`createX({ multica, ... })` returning `{ handle }`).
- **Security matters:** every value that goes to the CLI is validated first; every value rendered into HTML goes through `esc()`; text that leaves the server goes through `redact()`; writes require login + the `x-painel` header.
- **Language:** the UI and code comments are in Brazilian Portuguese today. English i18n is very welcome — keep strings easy to extract.
- Open an issue before large changes (new views, new dependencies) so we can agree on the approach.
