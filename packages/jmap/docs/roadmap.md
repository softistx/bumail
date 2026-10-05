# Roadmap

What `@bumail/jmap` gives a mail server, and what is coming. This page is a
direction, not a commitment: the version something shipped in is the only
number on it.

## Now

The second slice:

- **`Email/queryChanges` and `Mailbox/queryChanges`** (RFC 8620 §5.6) — a
  client that shows a query result keeps it current from the changes,
  instead of running the query again. `canCalculateChanges` turns true.
- **Push via EventSource** (RFC 8620 §7.3) — `eventSourceUrl` served with
  named `state` and `ping` events through alxia's `eventStream`, each
  `StateChange` with its `id:`, and `notify(accountId)` waking
  the account's streams at once after a delivery.
- **`Thread/changes`**, and threads that group replies by `In-Reply-To`
  and `References` as mail is delivered.

## Next

- **`Identity`** (RFC 8621 §6) — the addresses an account sends as.
- **`EmailSubmission`** (RFC 8621 §7) — sending, through
  `@bumail/queue`, which retries and bounces, over `@bumail/smtp/client`;
  `maySubmit` turns true.

## Later

- **`SearchSnippet/get`** (RFC 8621 §5) — the matching text of a search,
  highlighted.
- **`VacationResponse`** (RFC 8621 §8) — the auto-reply, with the
  delivery that sends it.
- **`Email/set` create from properties** — an email built from `from`,
  `subject` and `bodyStructure` with `@bumail/mime`, for drafts.
- **`Email/copy`, `Email/parse`, `Blob/copy`**, and `Mailbox/query` with
  `sortAsTree` and `filterAsTree`.
- **WebSocket push** (RFC 8887).

## Store gaps

What the server does here because `@bumail/store` does not yet, in memory
and bounded. Each comes out once the store contract grows it.

- **The account's state.** No call answers the modseq alone: it is read
  from the mailbox changes since 0, which list every mailbox id.
- **Search and sort.** No index: `Email/query` reads at most
  `maxQueryScan` emails and filters, sorts and searches them here,
  reading content for text conditions.
- **Threads.** A thread id per message, but no thread index:
  `Thread/get` reads the account's emails, and a mailbox's unread and
  thread counts list the mailbox. Messages are single threads unless the
  delivery passes a `threadId`.
- **A blob store.** Uploads are held in memory for `uploadTtl`, per
  process, up to `uploadQuota` per account.
- **`sortOrder`** on a mailbox, and a mailbox's `role` changing: always 0,
  never.
- **Atomic changes.** `ifInState` is checked before a call, not with its
  writes; a `mailboxIds` change is a link then a removal.
- **Rights.** No ACL: `myRights` grants everything but submission, and
  every account is personal.

## Not planned

- **Basic authentication on a clear connection** — not as a default; the
  `allowInsecureBasic` option is for local tests.
- **Accounts shared between users** — sharing is the store's question
  first; each session has one account.

## Shipped

### Unreleased

Merged, not yet published.

- **`@alxia/core` 0.7** — the peer range moves from `^0.3.1` to
  `^0.7.0`: an app on `@alxia/core` 0.3 upgrades it, and every other
  `@alxia/*` package, alongside this release, and mounts the server with
  `plugin(jmap(…))` rather than `use(jmap(…))`. The server's routes,
  statuses and bodies are unchanged.
- **`@alxia/core` 0.3.1** — the peer range moves from `^0.3.0` to
  `^0.3.1`, whose `parseRange` answers a range of an empty file as RFC
  9110 does: the server no longer works around it. Downloads answer as
  before: a suffix range of an empty blob serves it whole, `bytes=0-` and
  `bytes=-0` are a 416 with `bytes */0`.

### 0.3.0

- **An OpenAPI 3.1 document of the routes** — `@bumail/jmap/openapi.json`
  describes the session, the API's Request and Response envelopes with
  the RFC 8620 problems and method errors, the download with `Range`, the
  upload, the Basic and Bearer schemes, and `basePath` as a server
  variable: for a viewer, a gateway or a client generator. A spec keeps it
  in step with the routes, both ways.
- **`requestTooLarge` past `maxQueryScan`** — a query, a text search or
  a `Thread/get` that would read too much answers `requestTooLarge`, a
  method error RFC 8620 defines, instead of `tooLarge`, which is only a
  SetError.
- **A download's 416 is never cached** — `Cache-Control: no-store`, no
  body, and none of the blob's own headers; and a suffix range of an
  empty blob serves it whole, as RFC 9110 §14.2 allows.

### 0.2.0

- **Unread counts exactly as RFC 8621 §2 defines them** — a mailbox's
  `unreadEmails` and `unreadThreads` count an email as read whenever it
  has `$seen`, however the store keeps it (the IMAP `\Seen` flag, or a
  `$Seen` keyword in any case, as some clients write it), and leave out
  an email that has `$draft`. `unreadThreads` counts the threads with an
  unread email in the mailbox.
- **`@alxia/core` 0.3** — the peer range moves from `^0.2.1` to `^0.3.0`:
  an app on `@alxia/core` 0.2 upgrades it, and every other `@alxia/*`
  package, alongside this release. The server's routes and answers are
  unchanged.

### 0.1.0

- **The first slice** — a JMAP server on `@alxia/core` 0.2.1, mounted in a
  host app, serving any `@bumail/store`: the session with every core limit,
  Basic only over HTTPS and Bearer through an `authenticate` hook, the API
  with back-references and RFC 7807 problems, `Core/echo`, `Mailbox/get`,
  `/changes`, `/query` and `/set`, `Email/get` with every header form and
  body values, `/query`, `/changes`, `/set` and `/import`, `Thread/get`, and
  blob upload and download with ranges. Every input is bounded.
