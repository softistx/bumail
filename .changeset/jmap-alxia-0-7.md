---
'@bumail/jmap': minor
---

The `@alxia/core` peer moves from `^0.3.1` to `^0.7.0`, which drops 0.3: an app on `@alxia/core` 0.3 upgrades it, with every other `@alxia/*` package it uses, to take this release, and mounts the server with `app.plugin(jmap(…))` where it wrote `app.use(jmap(…))`, since `use` takes middlewares alone from `@alxia/core` 0.5 on. The routes' refusals are answered by a middleware of each route instead of the `onRefusal` hooks 0.5 removed; the server's routes, statuses, headers and bodies are unchanged. The OpenAPI spec checks the routes with `@alxia/openapi`'s `matchesSpec` under `strict: true`, both ways as before.
