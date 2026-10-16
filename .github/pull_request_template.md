## What and why

<!-- What does this change, and what problem does it solve? Link issues. -->

## How it was tested

<!-- Commands you ran and their result. New behaviour needs a test; concurrency/failure behaviour needs an integration test against real PostgreSQL/Redis. -->

- [ ] `npm run lint && npm run typecheck`
- [ ] `npm test` (unit + integration)
- [ ] `npm run test:e2e` (if the dashboard or API contract changed)

## Checklist

- [ ] State changes go through the transition table and a conditional `UPDATE` (no read-then-write races)
- [ ] Anything that must reach the queue is written to the outbox in the same transaction
- [ ] Every new query is scoped by `project_id` and served by an index (say which)
- [ ] No secrets, payloads or stack traces in logs or API errors
- [ ] Docs updated (`docs/`, README, OpenAPI descriptions) and migrations are new files, never edits
