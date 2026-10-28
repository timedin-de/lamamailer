# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## What this is
`lamapoll-mailer` (Node.js + TypeScript) sends a confirmation e-mail for every new LamaPoll signup. It polls
`GET /polls/{id}/legacyResults`, queues submissions in SQLite and sends over SMTP. All configuration (API key, poll,
e-mail field, SMTP, template, rules) happens in the admin UI; env vars are only HOST, PORT, DATA_DIR.
The PHP script it replaces lives in `../php` (reference for the CSV shape and the mail template).

## Workflow rules (mandatory)
1. **TypeScript** for all Node code. Node >= 24 runs `.ts` directly (type stripping): use `.ts` import extensions,
   `import type`, no enums / parameter properties (`erasableSyntaxOnly`). `npm run typecheck` must be clean.
2. **Red tests first.** Write the failing test, see it fail for the right reason, then implement.
3. **Few, meaningful commits** (per module/feature), Conventional Commits (`feat(scope): ...`), with the harness
   `Co-Authored-By` trailer. Run `npm run typecheck && npm test` before committing.
4. Never commit secrets or the `data/` directory.

## Commands
```sh
npm test | npm run typecheck | npm start
```

## Layout
```
src/server.ts              entry: wiring, loops, graceful shutdown, prints the setup code
src/core/store.ts          node:sqlite: queue, key/value, sessions (all state lives here)
src/core/settings.ts       all settings as one JSON document; readiness checks; secret masking
src/core/types.ts, util.ts shared types and helpers
src/lamapoll/client.ts     API client (polls, questions, legacyResults)  | csv.ts hand-written CSV parser
src/lamapoll/questions.ts  decode answers via question definitions; field pickers (ported from the PHP reference)
src/lamapoll/poller.ts     fetch -> decode -> queue
src/mail/sender.ts         queue -> render -> SMTP, retry/backoff | mailer.ts nodemailer wrapper
src/mail/template.ts       placeholder engine + answers table
src/web/app.ts             Express admin app: setup/login, settings wizard, dashboard, template, account
src/web/views.ts           server-rendered German HTML (everything through esc())
src/web/auth.ts            scrypt password hashes, tokens
test/                      node:test; fakes via small interfaces (ResultsSource, Mailer, ApiClient), injectable clocks
```

## Design invariants (do not break)
- **One submission = one mail.** Dedup key is `id:<vID>`, never the e-mail address.
- **All state in SQLite**; restart must be safe. Rows go `pending -> sending -> sent`; `sending` is written BEFORE the
  SMTP call. Stale `sending` rows are never resent automatically (admin decides).
- New rows and the watermark are written in ONE transaction. First poll after activation marks existing rows `skipped`
  unless the admin chose "auch vorhandene mailen".
- **Switching the poll deletes everything poll-related** (`Store.clearPollData`: signups, watermark, first-run flag,
  last poll, "activated") and disables the mailer, so the "existing signups" question is asked again. `vID`s are only
  unique per poll. A poll result that arrives after a switch is dropped.
- `dateFrom` is date-only by default (the PHP reference did that); overlap is one day, dedup by `vID` makes it harmless.
- Secrets (API key, SMTP password) are never rendered back into HTML; empty password field = keep the saved one.
- Template values are HTML-escaped; the subject is forced to one line (no header injection).
- Run in production with `node` directly (not `npm start`) so SIGTERM reaches the app.

## Gotchas
- In `openapi.json` (see `../openapi.json`) `legacyResults` query params are declared at PATH level.
- The real `legacyResults` response is `{ numCols, numLines, data }` - there is NO `success` flag (the spec example
  even has a typo "sucess"). Only check that `data` is a string.
- Polls: always use `name`, never `title` (the public title). `LamaPoll` has no `title` field on purpose.
- Exact `dateFrom` semantics and CSV columns still need one check against a real poll (see README).
