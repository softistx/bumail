/**
 * The first statement of every transaction that writes: READ COMMITTED
 * whatever the client's sessions default to. The claim's `FOR UPDATE SKIP
 * LOCKED` and the `maxItems` advisory lock count on it: under `repeatable
 * read` or `serializable`, a row another transaction changed since the
 * snapshot fails with SQLSTATE 40001, and the count taken after the lock
 * would read a snapshot from before it.
 */
export const READ_COMMITTED =
	'SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE';
