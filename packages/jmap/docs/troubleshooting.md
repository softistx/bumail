# Troubleshooting

Each entry is headed by the text you see: the message of an error thrown
or given to `onError`; the `detail` of a problem a request is refused with;
the `type`, and the `description`, of a method error or a SetError. `…`
stands for the part that varies. Search this page for the text, then
follow the link: the entries are split by topic.

Where an answer repeats the client's own text — a name, an argument, a
property, a capability — that text is cut after 100 characters (`...`
marks the cut) and its control characters are left out. A store's
message is cut after 200 characters the same way. Search for the fixed
part of the text.

| Page | What it covers |
| --- | --- |
| [Configuration and onError](troubleshooting/configuration.md) | what `jmap()` and `notify` throw, and the errors `onError` receives |
| [Authentication](troubleshooting/authentication.md) | the 401, 403 and 503 every route may answer first |
| [Requests, uploads and downloads](troubleshooting/requests.md) | the problems a whole request is refused with — `notJSON`, `notRequest`, `unknownCapability`, `limit` — and the 404s of downloads and uploads |
| [Method errors](troubleshooting/methods.md) | what one method call answers when it fails |
| [Objects not created, updated or destroyed](troubleshooting/objects.md) | the SetErrors of `Mailbox/set`, `Email/set` and `Email/import` |

**[Configuration and onError](troubleshooting/configuration.md)**

- [`JmapError: jmap(): the options must be an object`](troubleshooting/configuration.md#jmaperror-jmap-the-options-must-be-an-object)
- [`JmapError: jmap(): store must be a MailStore, such as new MemoryMailStore()`](troubleshooting/configuration.md#jmaperror-jmap-store-must-be-a-mailstore-such-as-new-memorymailstore)
- [`JmapError: jmap(): authenticate must be a function: it is how clients log in`](troubleshooting/configuration.md#jmaperror-jmap-authenticate-must-be-a-function-it-is-how-clients-log-in)
- [`JmapError: jmap(): … must be a function`](troubleshooting/configuration.md#jmaperror-jmap--must-be-a-function)
- [`JmapError: jmap(): origin must be an http: or https: origin, such as https://mail.example.com, not "…"`](troubleshooting/configuration.md#jmaperror-jmap-origin-must-be-an-http-or-https-origin-such-as-httpsmailexamplecom-not-)
- [`JmapError: jmap(): basePath must be a path such as /jmap, with no trailing slash, not "…"`](troubleshooting/configuration.md#jmaperror-jmap-basepath-must-be-a-path-such-as-jmap-with-no-trailing-slash-not-)
- [`JmapError: jmap(): limits must be an object`](troubleshooting/configuration.md#jmaperror-jmap-limits-must-be-an-object)
- [`JmapError: jmap(): limits.… is not a limit`](troubleshooting/configuration.md#jmaperror-jmap-limits-is-not-a-limit)
- [`JmapError: jmap(): … must be a positive integer, not …`](troubleshooting/configuration.md#jmaperror-jmap--must-be-a-positive-integer-not-)
- [`JmapError: jmap(): … must be at most …, not …`](troubleshooting/configuration.md#jmaperror-jmap--must-be-at-most--not-)
- [`TypeError: notify(accountId): accountId is a string`](troubleshooting/configuration.md#typeerror-notifyaccountid-accountid-is-a-string)
- [`JmapError: authenticate did not settle within hookTimeout (… s)`](troubleshooting/configuration.md#jmaperror-authenticate-did-not-settle-within-hooktimeout--s)
- [`Error: authenticate answered the account "…", which the store does not have`](troubleshooting/configuration.md#error-authenticate-answered-the-account--which-the-store-does-not-have)
- [`TypeError: authenticate must answer an account id, or null`](troubleshooting/configuration.md#typeerror-authenticate-must-answer-an-account-id-or-null)
- [`Error: The store has no content for the email "…"`](troubleshooting/configuration.md#error-the-store-has-no-content-for-the-email-)

**[Authentication](troubleshooting/authentication.md)**

- [`401 Authentication required`](troubleshooting/authentication.md#401-authentication-required)
- [`401 Authentication failed`](troubleshooting/authentication.md#401-authentication-failed)
- [`403 Basic authentication is refused on a clear connection: use HTTPS`](troubleshooting/authentication.md#403-basic-authentication-is-refused-on-a-clear-connection-use-https)
- [`503 Temporary authentication failure`](troubleshooting/authentication.md#503-temporary-authentication-failure)

**[Requests, uploads and downloads](troubleshooting/requests.md)**

- [`urn:ietf:params:jmap:error:notJSON` — `The request body is not UTF-8`](troubleshooting/requests.md#urnietfparamsjmaperrornotjson--the-request-body-is-not-utf-8)
- [`urn:ietf:params:jmap:error:notJSON` — `The request body is not JSON`](troubleshooting/requests.md#urnietfparamsjmaperrornotjson--the-request-body-is-not-json)
- [`urn:ietf:params:jmap:error:notRequest` — `The request is not a JSON object`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--the-request-is-not-a-json-object)
- [`urn:ietf:params:jmap:error:notRequest` — `using is not an array of capability names`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--using-is-not-an-array-of-capability-names)
- [`urn:ietf:params:jmap:error:notRequest` — `methodCalls is not an array`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--methodcalls-is-not-an-array)
- [`urn:ietf:params:jmap:error:notRequest` — `methodCalls[…] is not an array of a name, arguments and a call id`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--methodcalls-is-not-an-array-of-a-name-arguments-and-a-call-id)
- [`urn:ietf:params:jmap:error:notRequest` — `methodCalls[…] has no method name of 1 to 255 characters`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--methodcalls-has-no-method-name-of-1-to-255-characters)
- [`urn:ietf:params:jmap:error:notRequest` — `methodCalls[…]'s arguments are not an object`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--methodcallss-arguments-are-not-an-object)
- [`urn:ietf:params:jmap:error:notRequest` — `methodCalls[…] has no call id of at most 255 characters`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--methodcalls-has-no-call-id-of-at-most-255-characters)
- [`urn:ietf:params:jmap:error:notRequest` — `createdIds is not an object`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--createdids-is-not-an-object)
- [`urn:ietf:params:jmap:error:notRequest` — `createdIds holds more than … ids`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--createdids-holds-more-than--ids)
- [`urn:ietf:params:jmap:error:notRequest` — `createdIds["…"] is not a creation id and an id`](troubleshooting/requests.md#urnietfparamsjmaperrornotrequest--createdids-is-not-a-creation-id-and-an-id)
- [`urn:ietf:params:jmap:error:unknownCapability` — `The server does not support the capability "…"`](troubleshooting/requests.md#urnietfparamsjmaperrorunknowncapability--the-server-does-not-support-the-capability-)
- [`urn:ietf:params:jmap:error:limit` — `The request is larger than … bytes`](troubleshooting/requests.md#urnietfparamsjmaperrorlimit--the-request-is-larger-than--bytes)
- [`urn:ietf:params:jmap:error:limit` — `The JSON nests deeper than … levels`](troubleshooting/requests.md#urnietfparamsjmaperrorlimit--the-json-nests-deeper-than--levels)
- [`urn:ietf:params:jmap:error:limit` — `The JSON holds more than … tokens`](troubleshooting/requests.md#urnietfparamsjmaperrorlimit--the-json-holds-more-than--tokens)
- [`urn:ietf:params:jmap:error:limit` — `The request makes more than … method calls`](troubleshooting/requests.md#urnietfparamsjmaperrorlimit--the-request-makes-more-than--method-calls)
- [`urn:ietf:params:jmap:error:limit` — `The response would be larger than … bytes`](troubleshooting/requests.md#urnietfparamsjmaperrorlimit--the-response-would-be-larger-than--bytes)
- [`urn:ietf:params:jmap:error:limit` — `The account has … requests in flight already`](troubleshooting/requests.md#urnietfparamsjmaperrorlimit--the-account-has--requests-in-flight-already)
- [`urn:ietf:params:jmap:error:limit` — `The upload is larger than … bytes`](troubleshooting/requests.md#urnietfparamsjmaperrorlimit--the-upload-is-larger-than--bytes)
- [`urn:ietf:params:jmap:error:limit` — `The account has … uploads in flight already`](troubleshooting/requests.md#urnietfparamsjmaperrorlimit--the-account-has--uploads-in-flight-already)
- [`urn:ietf:params:jmap:error:limit` — `The account holds … bytes of uploads already: use them or wait for them to expire`](troubleshooting/requests.md#urnietfparamsjmaperrorlimit--the-account-holds--bytes-of-uploads-already-use-them-or-wait-for-them-to-expire)
- [`404 No blob has this id`](troubleshooting/requests.md#404-no-blob-has-this-id)
- [`404 No account has this id`](troubleshooting/requests.md#404-no-account-has-this-id)
- [`404 {"error":"not_found"}`](troubleshooting/requests.md#404-errornot_found)
- [`405 {"error":"method_not_allowed"}`](troubleshooting/requests.md#405-errormethod_not_allowed)

**[Method errors](troubleshooting/methods.md)**

- [`unknownMethod`](troubleshooting/methods.md#unknownmethod)
- [`accountNotFound`](troubleshooting/methods.md#accountnotfound)
- [`invalidArguments` — `accountId is required`](troubleshooting/methods.md#invalidarguments--accountid-is-required)
- [`invalidArguments` — `Unknown argument "…"`](troubleshooting/methods.md#invalidarguments--unknown-argument-)
- [`invalidArguments` — `… must be an array of ids`](troubleshooting/methods.md#invalidarguments---must-be-an-array-of-ids)
- [`invalidArguments` — `… holds "…", which is not an id`](troubleshooting/methods.md#invalidarguments---holds--which-is-not-an-id)
- [`invalidArguments` — `… must be an array of at most 256 property names`](troubleshooting/methods.md#invalidarguments---must-be-an-array-of-at-most-256-property-names)
- [`invalidArguments` — `… names "…", which is not a property`](troubleshooting/methods.md#invalidarguments---names--which-is-not-a-property)
- [`invalidArguments` — `… must be a boolean`](troubleshooting/methods.md#invalidarguments---must-be-a-boolean)
- [`invalidArguments` — `… must be an unsigned integer`](troubleshooting/methods.md#invalidarguments---must-be-an-unsigned-integer)
- [`invalidArguments` — `… must be an integer`](troubleshooting/methods.md#invalidarguments---must-be-an-integer)
- [`invalidArguments` — `… must be a string`](troubleshooting/methods.md#invalidarguments---must-be-a-string)
- [`invalidArguments` — `… must be an object`](troubleshooting/methods.md#invalidarguments---must-be-an-object)
- [`invalidArguments` — `create has "…", which is not a creation id`](troubleshooting/methods.md#invalidarguments--create-has--which-is-not-a-creation-id)
- [`invalidArguments` — `destroy must be an array of ids`](troubleshooting/methods.md#invalidarguments--destroy-must-be-an-array-of-ids)
- [`invalidArguments` — `update has "…", which is not an id`](troubleshooting/methods.md#invalidarguments--update-has--which-is-not-an-id)
- [`invalidArguments` — `destroy holds "…", which is not an id`](troubleshooting/methods.md#invalidarguments--destroy-holds--which-is-not-an-id)
- [`invalidArguments` — `emails["…"] is not an EmailImport`](troubleshooting/methods.md#invalidarguments--emails-is-not-an-emailimport)
- [`invalidArguments` — `Both "…" and "#…" are given`](troubleshooting/methods.md#invalidarguments--both--and--are-given)
- [`invalidArguments` — `maxChanges must be more than 0`](troubleshooting/methods.md#invalidarguments--maxchanges-must-be-more-than-0)
- [`invalidArguments` — `sort must be an array of at most 16 comparators`](troubleshooting/methods.md#invalidarguments--sort-must-be-an-array-of-at-most-16-comparators)
- [`invalidArguments` — `A comparator is an object with a property`](troubleshooting/methods.md#invalidarguments--a-comparator-is-an-object-with-a-property)
- [`invalidArguments` — `isAscending must be a boolean`](troubleshooting/methods.md#invalidarguments--isascending-must-be-a-boolean)
- [`invalidArguments` — `A filter is an object`](troubleshooting/methods.md#invalidarguments--a-filter-is-an-object)
- [`invalidArguments` — `A FilterOperator has an operator and conditions only`](troubleshooting/methods.md#invalidarguments--a-filteroperator-has-an-operator-and-conditions-only)
- [`invalidArguments` — `sortAsTree and filterAsTree are not supported yet`](troubleshooting/methods.md#invalidarguments--sortastree-and-filterastree-are-not-supported-yet)
- [`invalidResultReference` — `No earlier call has the id "…"`](troubleshooting/methods.md#invalidresultreference--no-earlier-call-has-the-id-)
- [`invalidResultReference` — `The call "…" answered "…", not "…"`](troubleshooting/methods.md#invalidresultreference--the-call--answered--not-)
- [`invalidResultReference` — `A ResultReference is an object of resultOf, name and path`](troubleshooting/methods.md#invalidresultreference--a-resultreference-is-an-object-of-resultof-name-and-path)
- [`invalidResultReference` — `The path "…" does not start with "/"`](troubleshooting/methods.md#invalidresultreference--the-path--does-not-start-with-)
- [`invalidResultReference` — `The path "…" names nothing in the result`](troubleshooting/methods.md#invalidresultreference--the-path--names-nothing-in-the-result)
- [`invalidResultReference` — `The path is longer than 1024 characters`](troubleshooting/methods.md#invalidresultreference--the-path-is-longer-than-1024-characters)
- [`invalidResultReference` — `The path has more than 32 segments`](troubleshooting/methods.md#invalidresultreference--the-path-has-more-than-32-segments)
- [`invalidResultReference` — `The reference expands to more than … values`](troubleshooting/methods.md#invalidresultreference--the-reference-expands-to-more-than--values)
- [`invalidResultReference` — `The references of this request resolve to more than … bytes`](troubleshooting/methods.md#invalidresultreference--the-references-of-this-request-resolve-to-more-than--bytes)
- [`requestTooLarge` — `… holds more than … ids`](troubleshooting/methods.md#requesttoolarge---holds-more-than--ids)
- [`requestTooLarge` — `The account has more than … mailboxes: ask for ids`](troubleshooting/methods.md#requesttoolarge--the-account-has-more-than--mailboxes-ask-for-ids)
- [`requestTooLarge` — `The account has more than … emails: ask for ids`](troubleshooting/methods.md#requesttoolarge--the-account-has-more-than--emails-ask-for-ids)
- [`requestTooLarge` — `Thread/get needs ids`](troubleshooting/methods.md#requesttoolarge--threadget-needs-ids)
- [`requestTooLarge` — `The call creates, updates and destroys more than … objects`](troubleshooting/methods.md#requesttoolarge--the-call-creates-updates-and-destroys-more-than--objects)
- [`requestTooLarge` — `emails holds more than … emails`](troubleshooting/methods.md#requesttoolarge--emails-holds-more-than--emails)
- [`cannotCalculateChanges` — `The state is not one this server gave`](troubleshooting/methods.md#cannotcalculatechanges--the-state-is-not-one-this-server-gave)
- [`cannotCalculateChanges`](troubleshooting/methods.md#cannotcalculatechanges)
- [`stateMismatch` — `The account has changed since ifInState`](troubleshooting/methods.md#statemismatch--the-account-has-changed-since-ifinstate)
- [`anchorNotFound`](troubleshooting/methods.md#anchornotfound)
- [`unsupportedSort` — `Sorting by "…" is not supported`](troubleshooting/methods.md#unsupportedsort--sorting-by--is-not-supported)
- [`unsupportedSort` — `Only the i;unicode-casemap collation is supported`](troubleshooting/methods.md#unsupportedsort--only-the-iunicode-casemap-collation-is-supported)
- [`unsupportedFilter` — `The filter "…" is not supported`](troubleshooting/methods.md#unsupportedfilter--the-filter--is-not-supported)
- [`unsupportedFilter` — `operator is AND, OR or NOT`](troubleshooting/methods.md#unsupportedfilter--operator-is-and-or-or-not)
- [`unsupportedFilter` — `Operators nest deeper than 16`](troubleshooting/methods.md#unsupportedfilter--operators-nest-deeper-than-16)
- [`unsupportedFilter` — `The filter holds more than 256 conditions`](troubleshooting/methods.md#unsupportedfilter--the-filter-holds-more-than-256-conditions)
- [`tooLarge` — `The query would read more than … emails: the store has no index yet`](troubleshooting/methods.md#toolarge--the-query-would-read-more-than--emails-the-store-has-no-index-yet)
- [`tooLarge` — `The query reads more than … emails`](troubleshooting/methods.md#toolarge--the-query-reads-more-than--emails)
- [`tooLarge` — `The account has more than … emails: the store has no thread index yet`](troubleshooting/methods.md#toolarge--the-account-has-more-than--emails-the-store-has-no-thread-index-yet)
- [`tooLarge` — `Counting threads would read more than … emails: leave totalThreads and unreadThreads out`](troubleshooting/methods.md#toolarge--counting-threads-would-read-more-than--emails-leave-totalthreads-and-unreadthreads-out)
- [`serverFail`](troubleshooting/methods.md#serverfail)

**[Objects not created, updated or destroyed](troubleshooting/objects.md)**

- [`notFound`](troubleshooting/objects.md#notfound)
- [`invalidProperties` — `name is required`](troubleshooting/objects.md#invalidproperties--name-is-required)
- [`invalidProperties` — `name is a string`](troubleshooting/objects.md#invalidproperties--name-is-a-string)
- [`invalidProperties` — `parentId names no mailbox`](troubleshooting/objects.md#invalidproperties--parentid-names-no-mailbox)
- [`invalidProperties` — `role is not one this server knows`](troubleshooting/objects.md#invalidproperties--role-is-not-one-this-server-knows)
- [`invalidProperties` — `isSubscribed is a boolean`](troubleshooting/objects.md#invalidproperties--issubscribed-is-a-boolean)
- [`invalidProperties` — `sortOrder can only be 0`](troubleshooting/objects.md#invalidproperties--sortorder-can-only-be-0)
- [`invalidProperties` — `This property cannot be set`](troubleshooting/objects.md#invalidproperties--this-property-cannot-be-set)
- [`invalidProperties` — `This property cannot be changed`](troubleshooting/objects.md#invalidproperties--this-property-cannot-be-changed)
- [`invalidProperties` — `…`, with `properties: ["name"]`](troubleshooting/objects.md#invalidproperties---with-properties-name)
- [`invalidProperties` — `…`, with `properties: ["parentId"]`](troubleshooting/objects.md#invalidproperties---with-properties-parentid)
- [`mailboxHasChild` — `The mailbox has child mailboxes`](troubleshooting/objects.md#mailboxhaschild--the-mailbox-has-child-mailboxes)
- [`mailboxHasEmail` — `The mailbox holds emails: set onDestroyRemoveEmails`](troubleshooting/objects.md#mailboxhasemail--the-mailbox-holds-emails-set-ondestroyremoveemails)
- [`invalidProperties` — `Only keywords and mailboxIds can be changed`](troubleshooting/objects.md#invalidproperties--only-keywords-and-mailboxids-can-be-changed)
- [`invalidProperties` — `… is an object of keys set to true`](troubleshooting/objects.md#invalidproperties---is-an-object-of-keys-set-to-true)
- [`invalidPatch` — `… is not a key set to true or null`](troubleshooting/objects.md#invalidpatch---is-not-a-key-set-to-true-or-null)
- [`invalidPatch` — `… is patched whole and by key at once`](troubleshooting/objects.md#invalidpatch---is-patched-whole-and-by-key-at-once)
- [`invalidProperties` — `mailboxIds names at least one mailbox, each of the account`](troubleshooting/objects.md#invalidproperties--mailboxids-names-at-least-one-mailbox-each-of-the-account)
- [`invalidProperties` — `An email is created from an uploaded blobId: this property cannot be set`](troubleshooting/objects.md#invalidproperties--an-email-is-created-from-an-uploaded-blobid-this-property-cannot-be-set)
- [`invalidProperties` — `blobId is required`](troubleshooting/objects.md#invalidproperties--blobid-is-required)
- [`invalidProperties` — `mailboxIds names at least one mailbox, each set to true`](troubleshooting/objects.md#invalidproperties--mailboxids-names-at-least-one-mailbox-each-set-to-true)
- [`invalidProperties` — `mailboxIds names a mailbox the account does not have`](troubleshooting/objects.md#invalidproperties--mailboxids-names-a-mailbox-the-account-does-not-have)
- [`invalidProperties` — `keywords is an object of keywords set to true`](troubleshooting/objects.md#invalidproperties--keywords-is-an-object-of-keywords-set-to-true)
- [`invalidProperties` — `receivedAt is a UTCDate`](troubleshooting/objects.md#invalidproperties--receivedat-is-a-utcdate)
- [`invalidProperties` — `…`, with `properties: ["mailboxIds"]`](troubleshooting/objects.md#invalidproperties---with-properties-mailboxids)
- [`invalidProperties` — `…`, with `properties: ["keywords"]`](troubleshooting/objects.md#invalidproperties---with-properties-keywords)
- [`invalidProperties` — `…`, with no properties](troubleshooting/objects.md#invalidproperties---with-no-properties)
- [`blobNotFound` — `No blob has this id`](troubleshooting/objects.md#blobnotfound--no-blob-has-this-id)
