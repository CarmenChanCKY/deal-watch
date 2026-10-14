# AGENTS.md

## Project context

Extended context and project facts: see [CONTEXT.md](CONTEXT.md).
Thinking process and decision history (problems, options, why): see [AI-ASSISTED-DEVELOPMENT.md](AI-ASSISTED-DEVELOPMENT.md).

## Collaboration rules (IMPORTANT)

- Business rules and system design are decided by the user only.
  AI may suggest options and trade-offs, but must not decide or implement them unilaterally.
- AI may write documentation when asked.
- The entire project (code, commits, documentation) is in English.
  Conversations with the user may be in Traditional Chinese (the user's language) or English.
- Scope: AI is responsible for coding only. If external actions are required (e.g. applying for API keys, creating accounts, configuring external services), do not perform them — inform the user and wait for them to provide the result.
- Clarification-first: If any requirement, context, or instruction is unclear or ambiguous, stop and ask the user instead of guessing or assuming.
- Small incremental tasks with confirmation: Break all work into small tasks, where each task delivers one independently verifiable outcome with a clear done criterion. After completing each task, pause and wait for explicit user confirmation before continuing.
- Keep [CONTEXT.md](CONTEXT.md), [AI-ASSISTED-DEVELOPMENT.md](AI-ASSISTED-DEVELOPMENT.md) and [README.md](README.md) clean and concise.
- When writing documentation, break content into short paragraphs with clear headings and lists for human readability.
- [AI-ASSISTED-DEVELOPMENT.md](AI-ASSISTED-DEVELOPMENT.md) is append-only: add new entries for new work; never modify, rewrite, or delete previously recorded entries.
- After code generation, briefly explain in chat what code was added, what it does, and why it was added.

### Coding style

- In `.gs` files, prefer `const` / `let` for variable declarations. Use `var` only as a last resort.
- Single-file: keep `src/Code.gs` as one file. Add new helpers to the matching section; do not split into multiple `.gs` files.
- Tidy defaults to zero behaviour change: extract, rename, or reorder only. Do not change return values, `Ui.alert` / Telegram texts, `Runs` / `Log` schema, or silent-vs-reply logic. Behaviour changes need a separate approved task.
- Small helpers over long functions: split functions into a thin orchestrator plus named helpers with early returns.
- Constants in Config: no bare URLs, lengths, unicode code points, or time factors outside Config. Use `UPPER_SNAKE` names.
- Named silent paths: every silent `return telegramOk_()` / `''` / `0` / `false` carries a reason comment plus a named predicate (e.g. `isReplayedUpdate_`).
- Shared Util: no copy-pasted Telegram fetch, redact, truncate, or error branches. Route through Util helpers (`telegramApiUrl_`, `redactToken_`, `truncateDebug_`, `mapSendError_`, `describeCallbackResult_`, `getRunsHeaderIndex_`).
- Naming and docs: private helpers end with `_`, public functions do not. Config uses `UPPER_SNAKE`, the rest uses `camelCase`. Every helper has a JSDoc line stating pure, Never throws, or silent behaviour.
- No new trace without approval: no `Logger.log`, no extra `Runs` / `Log` writes, no new `ScriptProperties` keys unless the user approves them in a separate task.

### Testing

Do not run, execute, or attempt to test the project after making changes.

After making changes:

- Do not start the application.
- Do not run tests.
- Do not run build commands.
- Do not run linting or type checking unless explicitly requested.
- Instead, provide clear instructions on how the user can test and verify the changes thwmselves.
- Include the relevant commands, test steps, and expected results when applicable.