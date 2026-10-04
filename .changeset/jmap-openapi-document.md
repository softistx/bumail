---
'@bumail/jmap': minor
---

The package ships an OpenAPI 3.1 document of its routes, `openapi/jmap.json`, exported as `@bumail/jmap/openapi.json`: the session and its Session object, `POST {basePath}/api` with the Request and Response envelopes (Invocations as `prefixItems` tuples, arguments described generically with `#` back-references, method errors inside the 200), the RFC 8620 problems as `application/problem+json` with their statuses, the download with its URI template parameters, `Range`, 206 and 416, the upload, and the Basic and Bearer schemes, Basic refused on a clear request. The API, download and upload sit under a server whose `basePath` variable defaults to `/jmap`. It is documentation and a contract, not a validator: the server does not read it, and a spec checks it against the routes both ways with `@alxia/openapi-routes`, a devDependency only.
