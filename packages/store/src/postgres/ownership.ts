import type { Writer } from './state';

// An account's content: a row per distinct bytes, counted by the messages
// of the account that use it. A blob is shared within an account only,
// and read only through an account that holds it.

/**
 * One more message of the account uses this blob: its row counts one
 * more, or is written with `content` when the account holds none yet.
 */
export async function retain(
	w: Writer,
	blobId: string,
	content?: { bytes: Uint8Array; size: number },
): Promise<void> {
	const counted = await w.rows(
		`UPDATE ${w.t.contents} SET uses = uses + 1
		WHERE account_id = $1 AND blob_id = $2 RETURNING uses`,
		[w.accountId, blobId],
	);
	if (counted.length > 0 || content === undefined) return;
	await w.rows(
		`INSERT INTO ${w.t.contents} (account_id, blob_id, uses, size, content)
		VALUES ($1, $2, 1, $3::bigint, $4::bytea)`,
		[w.accountId, blobId, content.size, content.bytes],
	);
}

/** One message fewer uses it: at none, the account no longer holds it, and its bytes go. */
export async function release(w: Writer, blobId: string): Promise<void> {
	await w.rows(
		`WITH used AS (
			UPDATE ${w.t.contents} SET uses = uses - 1
			WHERE account_id = $1 AND blob_id = $2 AND uses > 1 RETURNING uses
		)
		DELETE FROM ${w.t.contents} WHERE account_id = $1 AND blob_id = $2
			AND NOT EXISTS (SELECT 1 FROM used)`,
		[w.accountId, blobId],
	);
}
