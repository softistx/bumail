---
'@bumail/store': patch
---

The `MailStore` contract now states how long a content Blob stays valid: the Blob `readContent` returns is valid until its message leaves the account (destroyed, or its last mailbox removed), and reading it afterwards may fail.
