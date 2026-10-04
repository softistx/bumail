import type { Tables } from './connect';
import { COLUMNS } from './rows';

/**
 * The statements a store runs on its tables, written once per store: the
 * table names are its prefix's (checked to be a plain name), and every
 * value is a parameter. Each parameter is cast, so nothing depends on the
 * type a client infers for it; JSON goes as text, cast to `jsonb`.
 */
export function statementsOf({ items, messages }: Tables) {
	return {
		/** $1 id, $2 sender, $3 recipients, $4 size, $5 created_at, $6 message: the item and its message in one statement, or neither. */
		insert: `WITH item AS (
			INSERT INTO ${items} (id, sender, recipients, size, created_at,
				next_attempt_at, attempts, delay_notified)
			VALUES ($1, $2, $3::text::jsonb, $4::int, $5::float8, $5::float8, 0, false)
			RETURNING id)
		INSERT INTO ${messages} (item_id, content) SELECT id, $6::bytea FROM item`,
		/** Taken before counting, by every add given `maxItems`. */
		lockAdds: `SELECT pg_advisory_xact_lock(hashtext('${items}')) IS NULL`,
		count: `SELECT count(*)::int AS n FROM ${items}`,
		get: `SELECT ${COLUMNS} FROM ${items} WHERE id = $1`,
		list: `SELECT ${COLUMNS} FROM ${items}
			ORDER BY next_attempt_at, seq LIMIT $1::int OFFSET $2::int`,
		message: `SELECT content FROM ${messages} WHERE item_id = $1`,
		/**
		 * $1 owner, $2 now, $3 expiry. The earliest due item no other
		 * transaction holds, locked as it is picked — one being claimed
		 * elsewhere is skipped, not waited for — then leased.
		 */
		claim: `UPDATE ${items} SET lease_owner = $1, lease_expires_at = $3::float8
			WHERE seq = (SELECT seq FROM ${items}
				WHERE next_attempt_at <= $2::float8
					AND (lease_owner IS NULL OR lease_expires_at <= $2::float8)
				ORDER BY next_attempt_at, seq LIMIT 1
				FOR UPDATE SKIP LOCKED)
			RETURNING ${COLUMNS}`,
		renew: `UPDATE ${items} SET lease_expires_at = $1::float8
			WHERE id = $2 AND lease_owner = $3 RETURNING seq`,
		/** The owner's item, locked until the transaction ends. */
		held: `SELECT ${COLUMNS} FROM ${items}
			WHERE id = $1 AND lease_owner = $2 FOR UPDATE`,
		/** $1 id, $2 recipients, $3 next attempt, $4 attempts, $5 delay notified: the lease let go of. */
		record: `UPDATE ${items} SET recipients = $2::text::jsonb,
			next_attempt_at = $3::float8, attempts = $4::int,
			delay_notified = $5::boolean, lease_owner = NULL,
			lease_expires_at = NULL WHERE id = $1`,
		/** The message goes with it: ON DELETE CASCADE. */
		drop: `DELETE FROM ${items} WHERE id = $1 RETURNING ${COLUMNS}`,
		moveDue: `UPDATE ${items} SET next_attempt_at = $1::float8
			WHERE id = $2 RETURNING seq`,
		giveBack: `UPDATE ${items} SET next_attempt_at = $1::float8,
			lease_owner = NULL, lease_expires_at = NULL
			WHERE id = $2 AND lease_owner = $3 RETURNING seq`,
	} as const;
}

export type Statements = ReturnType<typeof statementsOf>;
