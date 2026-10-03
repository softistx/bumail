import type { Canonicalization } from './canon';

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const TAB = 0x09;
const CHUNK = 16_384;

/** What a body hash comes to once the body has ended. */
export interface BodyDigest {
	/** The SHA-256 of the canonical body, cut at the limit when there is one. */
	readonly hash: Uint8Array;
	/** Octets in the whole canonical body, the limit notwithstanding. */
	readonly length: number;
}

/**
 * Canonicalises a body as it streams in (RFC 6376 §3.4.3, §3.4.4) and
 * hashes the first `limit` octets of the result (`l=`). Memory stays
 * bounded whatever the body: empty lines at the end are counted, not kept,
 * until a line with content shows they were not the end.
 *
 * A line ends at CRLF or at a bare LF, which is read as CRLF: a message
 * stored with LF line ends hashes as the CRLF one sent over SMTP. A CR not
 * followed by LF is content.
 */
export class BodyHasher {
	readonly #relaxed: boolean;
	readonly #limit: number;
	readonly #hasher = new Bun.CryptoHasher('sha256');
	readonly #buffer = new Uint8Array(CHUNK);
	#used = 0;
	#length = 0;
	#emptyLines = 0;
	#content = false;
	#space = false;
	#cr = false;

	constructor(method: Canonicalization, limit = Number.POSITIVE_INFINITY) {
		this.#relaxed = method === 'relaxed';
		this.#limit = limit;
	}

	write(chunk: Uint8Array): void {
		for (let i = 0; i < chunk.length; i++) {
			const byte = chunk[i] as number;
			if (this.#cr) {
				this.#cr = false;
				if (byte === LF) {
					this.#endLine();
					continue;
				}
				this.#text(CR);
			}
			if (byte === CR) this.#cr = true;
			else if (byte === LF) this.#endLine();
			else if (this.#relaxed && (byte === SP || byte === TAB))
				this.#space = true;
			else this.#text(byte);
		}
	}

	/** Ends the body: a last line without its CRLF gets one, and simple's empty body is one CRLF. */
	end(): BodyDigest {
		if (this.#cr) {
			this.#cr = false;
			this.#text(CR);
		}
		if (this.#content) this.#endLine();
		if (this.#length === 0 && !this.#relaxed) {
			this.#emit(CR);
			this.#emit(LF);
		}
		this.#hasher.update(this.#buffer.subarray(0, this.#used));
		this.#used = 0;
		return {
			hash: new Uint8Array(this.#hasher.digest()),
			length: this.#length,
		};
	}

	#text(byte: number): void {
		if (!this.#content) {
			for (; this.#emptyLines > 0; this.#emptyLines--) {
				this.#emit(CR);
				this.#emit(LF);
			}
			this.#content = true;
		}
		if (this.#space) {
			this.#space = false;
			this.#emit(SP);
		}
		this.#emit(byte);
	}

	#endLine(): void {
		this.#space = false;
		if (this.#content) {
			this.#emit(CR);
			this.#emit(LF);
			this.#content = false;
		} else {
			this.#emptyLines++;
		}
	}

	#emit(byte: number): void {
		if (this.#length < this.#limit) {
			this.#buffer[this.#used++] = byte;
			if (this.#used === CHUNK) {
				this.#hasher.update(this.#buffer);
				this.#used = 0;
			}
		}
		this.#length++;
	}
}
