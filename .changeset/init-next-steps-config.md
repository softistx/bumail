---
'@bumail/server': patch
---

`bumail init` prints its next steps with the `--config` it was given, quoted for the shell when needed, so they reach the file it wrote outside the image too.
