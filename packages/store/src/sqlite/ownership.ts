import type { SqliteState } from './state';

// Which account holds which blob: a blob is shared within an account only,
// and read only through an account that holds it.

/** One more message of the account uses this blob. */
export function retain(
	state: SqliteState,
	accountId: string,
	blobId: string,
): void {
	state.db
		.query(
			`INSERT INTO account_blobs (account_id, blob_id, uses) VALUES (?, ?, 1)
			ON CONFLICT (account_id, blob_id) DO UPDATE SET uses = uses + 1`,
		)
		.run(accountId, blobId);
}

/** One message fewer uses it: at none, the account no longer holds it. */
export function release(
	state: SqliteState,
	accountId: string,
	blobId: string,
): void {
	const row = state.db
		.query<{ uses: number }, [string, string]>(
			`UPDATE account_blobs SET uses = uses - 1
			WHERE account_id = ? AND blob_id = ? AND uses > 1 RETURNING uses`,
		)
		.get(accountId, blobId);
	if (row) return;
	state.db
		.query('DELETE FROM account_blobs WHERE account_id = ? AND blob_id = ?')
		.run(accountId, blobId);
	state.released.add(blobId);
}

/** Every blob the account holds, released as it goes. */
export function releaseAll(state: SqliteState, accountId: string): void {
	const rows = state.db
		.query<{ blob_id: string }, [string]>(
			'SELECT blob_id FROM account_blobs WHERE account_id = ?',
		)
		.all(accountId);
	for (const { blob_id } of rows) state.released.add(blob_id);
}

/** Whether the account holds this blob. */
export function holds(
	state: SqliteState,
	accountId: string,
	blobId: string,
): boolean {
	return (
		state.db
			.query('SELECT 1 FROM account_blobs WHERE account_id = ? AND blob_id = ?')
			.get(accountId, String(blobId)) !== null
	);
}
