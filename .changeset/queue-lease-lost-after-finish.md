---
'@bumail/queue': patch
---

A worker that stalled past its lease, while another worker claimed the item, delivered it and dropped it, no longer reads the missing item as cancelled and emits `delivered` events for what it sent: it emits a `LEASE_LOST` error, no outcome event and no DSN, so the operator learns the message may have been sent twice. The store keeps no record of who dropped an item, so when only the lease's expiry passed the error says the item was lost to another worker or cancelled; when a renewal had found the item under another worker, it says that worker finished it. An item cancelled under a lease that still held is told as before — its outcomes on the events, no error, no DSN — and a renewal that finds the item gone no longer reports `LEASE_LOST`.
