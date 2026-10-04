/**
 * Text PostgreSQL keeps as it was given: no NUL (its `text` and `jsonb`
 * hold none, and refuse the statement) and no lone surrogate (which
 * `Bun.SQL` sends as U+FFFD, so the database would keep, and match,
 * other text). The same rule as `@bumail/queue`'s `isStorable`.
 */
export const isStorable = (text: unknown): text is string =>
	typeof text === 'string' && text.isWellFormed() && !text.includes('\0');
