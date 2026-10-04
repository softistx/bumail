import { ServerError } from '../errors';

/** The shortest password a user may be given, in characters. */
export const MIN_PASSWORD_LENGTH = 12;
/**
 * The longest password, in bytes of UTF-8: well past any passphrase, and
 * short enough that hashing one costs what hashing any other does. Also
 * the longest login `authenticate` looks up, as `@bumail/store`'s
 * PostgreSQL store caps a login.
 */
export const MAX_PASSWORD_BYTES = 1024;

/** OWASP's argon2id floor: 19 MiB, two passes, one lane. */
export const HASH_OPTIONS = {
	algorithm: 'argon2id',
	memoryCost: 19456,
	timeCost: 2,
} as const;

const encoder = new TextEncoder();

/** The UTF-8 length of `text`. */
export function byteLength(text: string): number {
	return encoder.encode(text).length;
}

/**
 * Refuses a password the directory does not keep: shorter than 12
 * characters, longer than 1024 bytes, or with a control character
 * (which no prompt types, and a file's trailing line break leaves).
 * The message never repeats the password.
 */
export function checkPassword(password: string): void {
	if (
		typeof password !== 'string' ||
		[...normalizePassword(password)].length < MIN_PASSWORD_LENGTH
	) {
		throw new ServerError(
			'INVALID',
			`the password must be at least ${MIN_PASSWORD_LENGTH} characters`,
		);
	}
	if (byteLength(normalizePassword(password)) > MAX_PASSWORD_BYTES) {
		throw new ServerError(
			'INVALID',
			`the password must be at most ${MAX_PASSWORD_BYTES} bytes`,
		);
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: what is refused
	if (/[\u0000-\u001f\u007f]/.test(password)) {
		throw new ServerError(
			'INVALID',
			'the password must not hold a control character, such as a line break',
		);
	}
}

/**
 * A password as it is hashed and verified: in Unicode NFC, as RFC 8265's
 * OpaqueString prepares one, so a passphrase typed on two systems that
 * compose `é` differently is one password.
 */
export function normalizePassword(password: string): string {
	return password.normalize('NFC');
}

/** The argon2id hash of `password`, normalized, as `Bun.password` encodes it. */
export function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(normalizePassword(password), HASH_OPTIONS);
}
