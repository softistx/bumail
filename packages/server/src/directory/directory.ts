import type { Database } from 'bun:sqlite';
import { addressOf } from './address';
import { Aliases } from './aliases';
import {
	Authenticator,
	type AuthenticatorOptions,
	type AuthResult,
} from './authenticate';
import { openDatabase } from './database';
import { Domains } from './domains';
import type { FailureLimiter } from './limiter';
import { Users } from './users';

export interface DirectoryOptions extends AuthenticatorOptions {
	/** The SQLite file, created if need be: `directory.url` without its `sqlite:`. */
	readonly file: string;
}

/**
 * Domains, users and aliases, in one SQLite file in WAL mode. Several
 * processes may open it at once — the server reads it, the `bumail`
 * command writes it — and every lookup reads the file, with no cache: a
 * change is seen by the next lookup, without a restart.
 */
export class Directory {
	readonly domains: Domains;
	readonly users: Users;
	readonly aliases: Aliases;
	readonly #db: Database;
	readonly #auth: Authenticator;

	private constructor(db: Database, options: AuthenticatorOptions) {
		this.#db = db;
		this.domains = new Domains(db);
		this.users = new Users(db);
		this.aliases = new Aliases(db);
		this.#auth = new Authenticator(this.users, options);
	}

	/** Opens the directory at `file`; what fails is `ServerError('UNAVAILABLE')`. */
	static open(options: DirectoryOptions): Directory {
		const { file, ...rest } = options;
		return new Directory(openDatabase(file), rest);
	}

	/** The failures counted per client, for the listeners to share. */
	get limiter(): FailureLimiter {
		return this.#auth.limiter;
	}

	/**
	 * Checks a login: `{ ok: true, user }`, or `{ ok: false, reason }`.
	 * At most `maxVerifies` run at once; a client blocked by the limiter
	 * is refused without a verify; an unknown login verifies a dummy hash,
	 * so it takes as long as a wrong password.
	 */
	authenticate(
		login: string,
		password: string,
		ip: string,
	): Promise<AuthResult> {
		return this.#auth.authenticate(login, password, ip);
	}

	/**
	 * The users mail for `address` goes to: the user itself, or an alias's
	 * targets, by address; `undefined` when nobody here has the address.
	 * A disabled user still receives mail.
	 */
	resolve(address: string): readonly string[] | undefined {
		const parsed = addressOf(address);
		if (parsed === undefined) return undefined;
		if (this.users.get(parsed.address) !== undefined) return [parsed.address];
		const targets = this.aliases.targets(parsed.address);
		return targets.length > 0 ? targets : undefined;
	}

	/** Closes the file; the directory is unusable afterwards. */
	close(): void {
		this.#db.close();
	}
}
