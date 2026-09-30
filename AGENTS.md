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
- [AI-ASSISTED-DEVELOPMENT.md](AI-ASSISTED-DEVELOPMENT.md) is append-only: add new entries for new work; never modify, rewrite, or delete previously recorded entries.
- After code generation, briefly explain in chat what code was added, what it does, and why it was added.

### Coding style

- In `.gs` files, prefer `const` / `let` for variable declarations. Use `var` only as a last resort.

### Testing

Do not run, execute, or attempt to test the project after making changes.

After making changes:

- Do not start the application.
- Do not run tests.
- Do not run build commands.
- Do not run linting or type checking unless explicitly requested.
- Instead, provide clear instructions on how the user can test and verify the changes thwmselves.
- Include the relevant commands, test steps, and expected results when applicable.