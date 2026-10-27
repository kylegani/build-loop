# Readiness

The bar every change is held to before it merges. The build loop's spec answers it for each task, its two readiness reviewers check each run against it, and its audit mode checks the whole repo against it. Each rule should point at where the project already writes it down; this file only collects them.

Setup: cut this to the project. Delete what doesn't apply, add what the project's own docs require, and replace each "(where)" with the doc and heading that holds the rule.

## 1. Who sees what

- Every request that reads or writes checks who is asking, in the handler itself. A parent route's or layout's check is not a boundary. (where)
- Every query is scoped to the caller's account or tenant. A record that belongs to someone else answers "not found" and shows nothing. Records with no owner column are scoped through their parent. (where)
- Permissions are checked on the server through one place, never a loose boolean. A hidden button is matched by a server refusal. (where)
- A search index or cache ranks and speeds up; the database decides. An access or consent flag is read from the stored record, never from the index. (where)
- Public endpoints return no private data, are rate limited, and say so in their code. (where)

## 2. Data at scale

- Every list is bounded: a limit, paging, and a stable order. Offset paging orders by a unique column last, or rows are skipped and repeated.
- No query per row. Related records load in one query or one batched query.
- A filter or search runs in the query, not after the limit.
- A long list renders only what is on screen.

## 3. Integrity

- Writes that belong together run in one transaction.
- Every update and delete is scoped to the rows it means.
- Status, type and category values are a fixed set the database enforces, not free text.
- A form that creates money or time records is safe to submit twice.
- A migration says what happens to every existing row, never edits a migration that already ran, and can run on a full production-sized table.

## 4. Failure and operations

- Actions that change access, money or personal records write an audit record.
- Anything that sends messages, stores files or signs people in is rate limited.
- Every state-changing request is protected against cross-site forgery, and a refusal is handled as a failure, not a success.
- A new setting or secret is set in every environment that reads it.
- Background work retries, and carries an idempotency key wherever a repeat would double an effect.
- Errors are logged with enough to find the cause, and never with secrets or personal data.

## 5. Complete screens

- Every screen has its full, empty, loading and failed states, at a desktop and a phone width, in every theme the product has.
- Words follow the project's writing guide; errors say what to do next.
- Every control can be reached and used with a keyboard, and text meets contrast rules.
