import { X509Certificate } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';

/** A client over `node:tls` that reads what it sent for, and which certificate it was served. */
export interface Peer {
	/** SHA-256 fingerprint of the certificate the server presented. */
	readonly fingerprint: string;
	/** Sends `line`, then waits for text matching `until`. */
	ask(line: string, until: RegExp): Promise<string>;
	end(): void;
}

/** The SHA-256 fingerprint of the first certificate in a PEM, as `node:tls` reports one. */
export const fingerprintOf = (pem: string): string =>
	new X509Certificate(pem).fingerprint256;

class Reader {
	#text = '';
	#waiters: (() => void)[] = [];

	constructor(socket: Socket | TLSSocket) {
		socket.on('data', (chunk: Buffer) => {
			this.#text += chunk.toString('latin1');
			for (const wake of this.#waiters.splice(0)) wake();
		});
		socket.on('close', () => {
			for (const wake of this.#waiters.splice(0)) wake();
		});
		socket.on('error', () => {});
	}

	/** What arrived up to the end of the first match of `until`; the rest stays. */
	async until(until: RegExp): Promise<string> {
		const end = Date.now() + 5000;
		for (;;) {
			const match = until.exec(this.#text);
			if (match) {
				const taken = this.#text.slice(0, match.index + match[0].length);
				this.#text = this.#text.slice(taken.length);
				return taken;
			}
			if (Date.now() > end) throw new Error(`no ${until} in ${this.#text}`);
			await Promise.race([
				new Promise<void>((wake) => this.#waiters.push(wake)),
				Bun.sleep(50),
			]);
		}
	}
}

function peerOf(socket: TLSSocket, reader: Reader): Peer {
	const certificate = socket.getPeerCertificate();
	return {
		fingerprint: certificate.fingerprint256,
		async ask(line, until) {
			socket.write(line);
			return reader.until(until);
		},
		end: () => socket.destroy(),
	};
}

/** Implicit TLS: the handshake is the first thing, on `port` itself or a proxy in front. */
export async function implicitPeer(port: number): Promise<Peer> {
	const socket = tlsConnect({
		host: '127.0.0.1',
		port,
		rejectUnauthorized: false,
	});
	const reader = new Reader(socket);
	await new Promise<void>((done, fail) => {
		socket.once('secureConnect', done);
		socket.once('error', fail);
	});
	return peerOf(socket, reader);
}

/**
 * STARTTLS: once the `greeting` came, `command` asks for TLS and `ready`
 * answers it; the handshake then runs on the same socket.
 */
export async function startTlsPeer(
	port: number,
	steps: {
		readonly greeting: RegExp;
		readonly command: string;
		readonly ready: RegExp;
	},
): Promise<Peer> {
	const raw = connect({ host: '127.0.0.1', port });
	const clear = new Reader(raw);
	await clear.until(steps.greeting);
	raw.write(steps.command);
	await clear.until(steps.ready);
	raw.removeAllListeners('data');
	const socket = tlsConnect({ socket: raw, rejectUnauthorized: false });
	const reader = new Reader(socket);
	await new Promise<void>((done, fail) => {
		socket.once('secureConnect', done);
		socket.once('error', fail);
	});
	return peerOf(socket, reader);
}
