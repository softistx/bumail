---
---

Internal refactor of `@bumail/store`: the rules every store shares (paging, change rules, checks, reading content, the tombstone specs) move from the memory store into `src/contract/`, with no change to the public surface.
