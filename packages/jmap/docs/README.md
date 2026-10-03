# @bumail/jmap documentation

The [package README](../README.md) is the short version. This folder is the
long one.

| Page | Read it when |
| --- | --- |
| [Guide](guide.md) | mounting the server in an alxia app; writing `authenticate`; reading the session; knowing what each method does with the store — mailboxes, emails, threads — how blobs are uploaded and downloaded, what a state is, setting the limits; or checking which RFC a behaviour follows |
| [Troubleshooting](troubleshooting.md) | you have an error's text and want its entry: the index of every entry, by its exact text |
| [Troubleshooting: configuration and onError](troubleshooting/configuration.md) | `jmap()` threw, or `onError` was called |
| [Troubleshooting: authentication](troubleshooting/authentication.md) | a client got a 401, a 403 or a 503 |
| [Troubleshooting: requests, uploads and downloads](troubleshooting/requests.md) | a request was refused with a problem — `notJSON`, `notRequest`, `unknownCapability`, `limit` — or a download or an upload got a 404 |
| [Troubleshooting: method errors](troubleshooting/methods.md) | a method call answered `error` |
| [Troubleshooting: objects](troubleshooting/objects.md) | a `/set` or an `Email/import` listed an object in `notCreated`, `notUpdated` or `notDestroyed` |
| [Roadmap](roadmap.md) | wondering what is coming — queryChanges, push, Identity, EmailSubmission, SearchSnippet, VacationResponse — what the store still lacks, and what is not planned |
