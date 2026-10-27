---
name: security-check
description: Review a change for security regressions. Use as the security gate of the build loop, and before reporting done any change to request handlers, auth, permissions, a public or integration API, file handling, emails, background jobs or dependencies.
---

# Security review

## Scope

`git diff origin/<base>...HEAD` and the untracked files, where `<base>` is `baseBranch` in `.claude/workflows/loop.config.json`. Read the project's own security docs, by heading, for what the change touches. Learn how this framework, at the installed version, does auth, sessions, forgery protection and output escaping before judging the code against it.

## Check

1. **Auth in every handler.** Each request handler that reads or writes checks who is asking, itself. A parent route's, layout's or middleware's check is not a boundary unless the framework guarantees it runs on every path to the handler; check that it does.
2. **Tenancy.** Every query is scoped to the caller's account or tenant. A record that belongs to someone else answers "not found", not "forbidden", and never leaks its data. Records with no owner column are scoped through their parent.
3. **Permissions.** Checked on the server through the project's one permission path. A hidden control is matched by a server refusal. An ID from the request is never trusted to say whose data it is.
4. **Forgery.** Every state-changing request is protected the way the framework expects, and a refusal is handled as a failure, never shown as a success.
5. **Indexes and caches never authorize.** A consent or access flag is read from the stored record, never from a search index or cache, even when the query filtered on it.
6. **Public and integration endpoints** return no private data, are rate limited, check their credential, and refuse what their contract doesn't allow. An origin allowlist binds browsers only; it is not an authorization boundary.
7. **Injection and output.** No raw SQL built from input, no unescaped user content in HTML, no string-built HTML in emails, no shell commands built from input. Redirects go only to allowed destinations.
8. **Files.** Uploads are checked for type and size, stored outside the web root or behind signed URLs, and served with the right content type.
9. **Secrets and logs.** No secret, token, session id or personal data in a URL, a log line, page data sent to the browser, or client code. A new secret is set in every environment that reads it, and nowhere in the repo.
10. **Dependencies.** A new package is necessary, maintained and pinned in the lockfile, and the package manager's audit adds no high or critical advisory.
11. **Rate limits and audit records** for anything new that sends messages, stores files, signs in or changes access or money.
12. **Security tests still prove what they claim.** A test that greps for a word only proves the word is in a file, not that it is on the request path; check the path yourself.

## Report

Findings most severe first, each with the file and line, the concrete way it could be abused, and the fix. Say what you checked and found clean.
