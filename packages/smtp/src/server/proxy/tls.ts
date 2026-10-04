import { Duplex } from 'node:stream';
import { type SecureContext, TLSSocket } from 'node:tls';
import type { Socket } from 'bun';

/** What the TLS session tells the listener. */
export interface TlsEvents {
	/** The handshake completed. */
	secure(): void;
	/** Bytes from the client, decrypted. */
	data(bytes: Uint8Array): void;
	/** What was written has left: the transport may write more. */
	drain(): void;
}

/**
 * Implicit TLS behind a PROXY header. A listener with `tls` would take the
 * header for a broken ClientHello, so the listener is a clear one, and TLS
 * starts once the header is read. Bun's `socket.upgradeTLS` cannot be
 * used: it reads only what arrives after it, and a proxy sends the
 * client's ClientHello in the same segment as the header as often as not
 * (Bun 1.4.2: the handshake then never completes). So the TLS session is
 * `node:tls` over a stream this class feeds: what followed the header
 * first, then every chunk of the raw socket's `data` (`receive`).
 *
 * It has the shape of the Bun socket a `SocketTransport` drives. `write`
 * takes nothing while TLS holds more than its high-water mark, and
 * `drain` comes once it took it all; the stream under it hands the raw
 * socket what it takes and waits for the raw `drain` for the rest, so a
 * client that reads slowly holds the server back, never its memory.
 */
export class ProxiedTls {
	readonly #raw: Socket<unknown>;
	readonly #wire: Duplex;
	readonly #tls: TLSSocket;
	/** What the raw socket did not take yet, and the stream's callback for it. */
	#pending: { bytes: Uint8Array; done: () => void } | undefined;
	/** How the raw socket closes once TLS ended: `shutdown(true)` or `shutdown()`. */
	#halfClose = true;

	constructor(raw: Socket<unknown>, context: SecureContext, events: TlsEvents) {
		this.#raw = raw;
		this.#wire = new Duplex({
			read() {},
			write: (chunk: Uint8Array, _encoding, done) => this.#send(chunk, done),
			final: (done) => {
				this.#raw.shutdown(this.#halfClose);
				done();
			},
		});
		this.#tls = new TLSSocket(this.#wire as never, {
			isServer: true,
			secureContext: context,
		});
		this.#tls.on('secure', () => events.secure());
		this.#tls.on('data', (bytes: Uint8Array) => events.data(bytes));
		this.#tls.on('drain', () => events.drain());
		// A broken handshake or record: nothing to say, no one to say it to.
		this.#tls.on('error', () => this.terminate());
	}

	get remoteAddress(): string {
		return this.#raw.remoteAddress;
	}

	/** The raw socket's `data`: TLS records from the client. */
	receive(chunk: Uint8Array): void {
		this.#wire.push(Uint8Array.from(chunk));
	}

	/** The raw socket's `drain`: it can take more of what TLS wrote. */
	rawDrain(): void {
		const pending = this.#pending;
		if (!pending) return;
		const written = Math.max(this.#raw.write(pending.bytes), 0);
		if (written < pending.bytes.length) {
			pending.bytes = pending.bytes.subarray(written);
			return;
		}
		this.#pending = undefined;
		pending.done();
	}

	#send(chunk: Uint8Array, done: () => void): void {
		const written = Math.max(this.#raw.write(chunk), 0);
		if (written < chunk.length) {
			this.#pending = { bytes: chunk.subarray(written), done };
		} else done();
	}

	write(bytes: Uint8Array): number {
		if (this.#tls.destroyed || this.#tls.writableNeedDrain) return 0;
		this.#tls.write(bytes);
		return bytes.length;
	}

	/**
	 * Ends TLS — a close_notify after everything written — then the raw
	 * socket, as `shutdown(halfClose)` would. Nothing written is lost, so
	 * the two differ only in the raw socket's close.
	 */
	shutdown(halfClose = false): void {
		this.#halfClose = halfClose;
		// TLS ended — its close_notify written to the wire — ends the wire too,
		// which closes the raw socket once what it holds has left: waiting for
		// the client's own close_notify would hold a client that stopped
		// reading for as long as it likes.
		this.#tls.once('finish', () => this.#wire.end());
		this.#tls.end();
	}

	terminate(): void {
		this.#pending = undefined;
		this.#tls.destroy();
		this.#raw.terminate();
	}

	/** The raw socket closed: TLS has nowhere to go. */
	closed(): void {
		this.#pending = undefined;
		this.#tls.destroy();
	}

	pause(): void {
		this.#raw.pause();
	}

	resume(): void {
		this.#raw.resume();
	}

	timeout(seconds: number): void {
		this.#raw.timeout(seconds);
	}
}
