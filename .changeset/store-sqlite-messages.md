---
---

Internal: the `bun:sqlite` store in `@bumail/store` now answers the whole `MailStore` contract — messages, content, flags, moves, copies, links and message changes — still kept out of the build. The memory store's message checks, flag rule and "not empty" error move into shared modules both stores call; its behaviour and every error are unchanged.
