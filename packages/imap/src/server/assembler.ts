import {
	type AppendStream,
	appendTarget,
	beginAppend,
} from '../commands/append';
import { concat, type LiteralMarker } from '../protocol/reader';
import { type Piece, tagged } from '../protocol/response';
import type { Connection } from './connection';
import { dispatch } from './dispatch';
import {
	MAX_LITERAL_BEFORE_LOGIN,
	MAX_LITERALS,
	MAX_LITERALS_BEFORE_LOGIN,
} from './settings';

/** A literal being read: kept, streamed into an APPEND, or dropped. */
type Pending =
	| { readonly keep: Uint8Array[] }
	| { readonly stream: AppendStream }
	| { readonly drop: true };

const EMPTY = new Uint8Array(0);

/** The tag of a line, as far as it can be told, for a refusal; `*` otherwise. */
export function tagOf(line: string | undefined): string {
	const tag = /^[!#$&',-[\]-z|}~]{1,64}(?= |$)/.exec(line ?? '')?.[0];
	return tag ?? '*';
}

/**
 * Puts a command together from its lines and literals, then runs it. A
 * literal is announced, checked against the limits, answered `+` when it is
 * synchronising, then read: kept when it is small, streamed into the store
 * when it is APPEND's message, dropped when refused. A non-synchronising
 * literal over a limit cannot be refused without reading it: the server
 * says BYE instead (RFC 7888 §4).
 */
export class Assembler {
	readonly #connection: Connection;
	#lines: string[] = [];
	#literals: Uint8Array[] = [];
	#literal: Pending | undefined;
	/** An APPEND whose message literal was read: it ends with its line. */
	#append: AppendStream | undefined;

	constructor(connection: Connection) {
		this.#connection = connection;
	}

	#reset(): void {
		this.#lines = [];
		this.#literals = [];
		this.#literal = undefined;
	}

	abort(): void {
		this.#append?.abort();
		this.#append = undefined;
		if (this.#literal && 'stream' in this.#literal)
			this.#literal.stream.abort();
		this.#reset();
	}

	async line(text: string, marker?: LiteralMarker): Promise<void> {
		this.#lines.push(text);
		if (marker && this.#append) {
			// A second message on the line: MULTIAPPEND (RFC 3502).
			this.#append.abort();
			this.#append = undefined;
			return this.#refuse(marker, 'BAD', 'MULTIAPPEND is not supported');
		}
		if (marker) return this.#announce(marker);
		const framed = { lines: this.#lines, literals: this.#literals };
		this.#reset();
		const append = this.#append;
		this.#append = undefined;
		const connection = this.#connection;
		if (append) return connection.exclusive(() => append.finish(text));
		return connection.exclusive(() => dispatch(connection, framed));
	}

	async tooLong(event: {
		head: string;
		literal?: LiteralMarker;
	}): Promise<void> {
		const tag = tagOf(this.#lines[0] ?? event.head);
		this.abort();
		const connection = this.#connection;
		if (event.literal && !event.literal.sync) {
			return connection.close('Command line too long, closing');
		}
		await connection.send(tagged(tag, 'BAD', 'Command line too long'));
	}

	async data(bytes: Uint8Array, last: boolean): Promise<void> {
		const literal = this.#literal;
		if (!literal) return;
		if ('keep' in literal) literal.keep.push(bytes);
		else if ('stream' in literal) await literal.stream.write(bytes);
		if (last) this.#done();
	}

	#done(): void {
		const literal = this.#literal;
		this.#literals.push(
			literal && 'keep' in literal ? concat(literal.keep) : EMPTY,
		);
		if (literal && 'stream' in literal) this.#append = literal.stream;
		this.#literal = undefined;
	}

	async #refuse(
		marker: LiteralMarker,
		status: 'NO' | 'BAD',
		text: string,
	): Promise<void> {
		const tag = tagOf(this.#lines[0]);
		this.abort();
		if (!marker.sync) return this.#connection.close(`${text}, closing`);
		await this.#connection.send(tagged(tag, status, text));
	}

	/** Before login, a refusal past the little LOGIN needs. */
	#beforeLogin(marker: LiteralMarker): Promise<void> | undefined {
		if (this.#literals.length >= MAX_LITERALS_BEFORE_LOGIN) {
			return this.#refuse(
				marker,
				'BAD',
				`More than ${MAX_LITERALS_BEFORE_LOGIN} literals before login`,
			);
		}
		if (marker.size > MAX_LITERAL_BEFORE_LOGIN) {
			return this.#refuse(
				marker,
				'BAD',
				`[TOOBIG] Literal over ${MAX_LITERAL_BEFORE_LOGIN} bytes before login`,
			);
		}
		return undefined;
	}

	async #announce(marker: LiteralMarker): Promise<void> {
		const connection = this.#connection;
		const { maxMessageSize, maxLiteralSize } = connection.settings;
		if (connection.state.phase === 'not-authenticated') {
			const refused = this.#beforeLogin(marker);
			if (refused) return refused;
		}
		if (this.#literals.length >= MAX_LITERALS) {
			return this.#refuse(
				marker,
				'BAD',
				`More than ${MAX_LITERALS} literals in one command`,
			);
		}
		const framed = { lines: this.#lines, literals: this.#literals };
		const target =
			connection.state.phase === 'not-authenticated'
				? undefined
				: appendTarget(framed);
		if (target) {
			if (marker.size > maxMessageSize) {
				return this.#refuse(
					marker,
					'NO',
					`[TOOBIG] The message is over ${maxMessageSize} bytes`,
				);
			}
			const begun = await connection.exclusive(() =>
				beginAppend(connection, target, marker.size),
			);
			if ('refusal' in begun && marker.sync) {
				this.#reset();
				return connection.send(begun.refusal);
			}
			this.#literal = 'refusal' in begun ? { drop: true } : { stream: begun };
			if ('refusal' in begun)
				this.#append = refusalOnly(connection, begun.refusal);
		} else if (marker.size > maxLiteralSize) {
			return this.#refuse(
				marker,
				'BAD',
				`[TOOBIG] Literal over ${maxLiteralSize} bytes`,
			);
		} else {
			this.#literal = { keep: [] };
		}
		if (marker.sync) await connection.send(['+ Ready for literal data\r\n']);
		connection.input.reader.expectLiteral(marker.size);
		if (marker.size === 0) this.#done();
	}
}

/** An APPEND refused after its non-synchronising literal: the refusal goes once the literal is read. */
function refusalOnly(connection: Connection, refusal: Piece[]): AppendStream {
	return {
		write: async () => {},
		finish: () => connection.send(refusal),
		abort: () => {},
	};
}
