import { expect } from 'bun:test';
import type { Socket, TCPSocketListener } from 'bun';
import { SmtpError } from '../errors';
import { Outgoing } from '../io/outgoing';
import type { Envelope, SmtpServerOptions } from '../server/options';
import { createSmtpServer, type SmtpServer } from '../server/server';

const fixture = (name: string) =>
	Bun.file(new URL(`../server/fixtures/${name}`, import.meta.url));

/** The self-signed certificate of `localhost` and `127.0.0.1` the server specs use. */
export const TLS = {
	key: await fixture('localhost.key').text(),
	cert: await fixture('localhost.crt').text(),
};

/** A message the server read to its end. */
export interface Received {
	readonly envelope: Envelope;
	/** The message, the server's Received field on top. */
	readonly text: string;
	readonly size: number;
}

const servers: SmtpServer[] = [];
const fakes: TCPSocketListener<unknown>[] = [];

/** Stops every server a spec started: for `afterEach`. */
export function stopServers(): void {
	for (const server of servers.splice(0)) server.stop(true);
	for (const fake of fakes.splice(0)) fake.stop(true);
}

/** This package's own server on an ephemeral port: an MX for `foo.com`, with STARTTLS and AUTH for alice unless `clear`. */
export async function startServer(
	overrides: Partial<SmtpServerOptions> = {},
	clear = false,
): Promise<{ port: number; received: Received[] }> {
	const received: Received[] = [];
	const server = createSmtpServer({
		hostname: 'foo.com',
		localDomains: ['foo.com'],
		...(clear
			? {}
			: {
					tls: TLS,
					authenticate: ({ username, password }) =>
						username === 'alice' && password === 'secret',
				}),
		onData: async (message) => {
			const bytes = await new Response(message.content).bytes();
			const text = new TextDecoder().decode(bytes);
			received.push({ envelope: message.envelope, text, size: bytes.length });
		},
		...overrides,
	});
	servers.push(server);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return { port, received };
}

/** What a fake server answers a command line with: text to write, `null` to hang up, `undefined` for its default. */
export type Answer = string | null | undefined;

/** A raw server on `Bun.listen`, for what this package's own server never does. */
export interface FakeScript {
	/** Written on connecting; default `220 fake ESMTP\r\n`. */
	readonly greeting?: string;
	/** Lines after the greeting in the EHLO reply; default PIPELINING, 8BITMIME. */
	readonly ehlo?: readonly string[];
	/** Asked first for each command line; `undefined` falls back to a plain 250. */
	command?(line: string, socket: Socket<unknown>): Answer;
	/** Called on each connection, before the greeting; true skips the greeting. */
	connected?(socket: Socket<unknown>, count: number): boolean | undefined;
}

/** A fake server, and every command line it was sent. */
export async function fakeServer(
	script: FakeScript = {},
): Promise<{ port: number; lines: string[] }> {
	const lines: string[] = [];
	let count = 0;
	const ehlo = script.ehlo ?? ['PIPELINING', '8BITMIME'];
	const state = new Map<
		Socket<unknown>,
		{ buffer: string; data: boolean; out: Outgoing }
	>();
	const write = (socket: Socket<unknown>, text: string) =>
		state.get(socket)?.out.write(new TextEncoder().encode(text));
	const answer = (socket: Socket<unknown>, line: string): Answer => {
		const own = script.command?.(line, socket);
		if (own !== undefined) return own;
		const verb = line.slice(0, 4).toUpperCase();
		if (verb === 'EHLO') {
			const all = ['fake', ...ehlo];
			const last = all.length - 1;
			return all.map((e, i) => `250${i === last ? ' ' : '-'}${e}\r\n`).join('');
		}
		if (verb === 'DATA') return '354 go\r\n';
		if (verb === 'QUIT') return '221 bye\r\n';
		return '250 ok\r\n';
	};
	const listener = Bun.listen<unknown>({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open(socket) {
				const out = new Outgoing((bytes) => socket.write(bytes));
				state.set(socket, { buffer: '', data: false, out });
				if (script.connected?.(socket, ++count)) return;
				write(socket, script.greeting ?? '220 fake ESMTP\r\n');
			},
			drain(socket) {
				state.get(socket)?.out.drain();
			},
			data(socket, chunk) {
				const s = state.get(socket);
				if (!s) return;
				s.buffer += new TextDecoder().decode(chunk);
				for (;;) {
					if (s.data) {
						const end = s.buffer.indexOf('\r\n.\r\n');
						if (end < 0) return;
						lines.push(`<message ${end + 2} bytes>`);
						s.buffer = s.buffer.slice(end + 5);
						s.data = false;
						write(socket, '250 queued\r\n');
						continue;
					}
					const lf = s.buffer.indexOf('\r\n');
					if (lf < 0) return;
					const line = s.buffer.slice(0, lf);
					s.buffer = s.buffer.slice(lf + 2);
					lines.push(line);
					const reply = answer(socket, line);
					if (reply === null) {
						socket.end();
						return;
					}
					if (reply !== undefined) write(socket, reply);
					if (reply?.startsWith('354')) s.data = true;
				}
			},
			close(socket) {
				state.delete(socket);
			},
		},
	});
	fakes.push(listener as TCPSocketListener<unknown>);
	return { port: listener.port, lines };
}

/** What a delivery rejected with: an `SmtpError`, or the spec fails. */
export async function failure(promise: Promise<unknown>): Promise<SmtpError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(SmtpError);
	return error as SmtpError;
}
