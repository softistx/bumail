---
"@bumail/store": patch
---

`findMailbox`'s role check moves into the contract's shared helpers, beside `createMailbox`'s, with no change in behaviour; a contract spec now pins that a message added and destroyed since a modseq is still listed in `expunged`.
