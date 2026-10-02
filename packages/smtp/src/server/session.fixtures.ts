import { Connection, type Transport } from './connection';
import type { ReceivedMessage, SmtpServerOptions } from './options';
import { settingsOf } from './settings';

/** A session on a fake socket: what the client sends, what the server answered. */
export interface FakeSession {
	readonly connection: Connection;
	/** What the server said on connecting. */
	readonly greeting: string;
	/** Messages handed to `onData`. */
	readonly received: ReceivedMessage[];
	/** Sends text, waits for every reply to it, and returns them. */
	send(text: string): Promise<string>;
	/** Whether the server hung up. */
	readonly ended: boolean;
	/** Times the server started TLS. */
	readonly tlsStarts: number;
}

/** The base options of the specs: an MX for `foo.com`, keeping what it receives. */
export function mxOptions(
	overrides: Partial<SmtpServerOptions> = {},
): SmtpServerOptions {
	return {
		hostname: 'foo.com',
		localDomains: ['foo.com'],
		onData: () => undefined,
		...overrides,
	};
}

/** Self-signed, for specs only: what STARTTLS needs to be offered. */
export const FAKE_TLS = { key: 'fake', cert: 'fake' };

export async function fakeSession(
	options: SmtpServerOptions,
	{ secure = false, remoteAddress = '192.0.2.10' } = {},
): Promise<FakeSession> {
	const received: ReceivedMessage[] = [];
	let output = '';
	let ended = false;
	let tlsStarts = 0;
	let encrypted = secure;
	const transport: Transport = {
		remoteAddress,
		get secure() {
			return encrypted;
		},
		write: (text) => {
			output += text;
		},
		end: () => {
			ended = true;
		},
		startTls: () => {
			tlsStarts++;
			encrypted = true;
		},
	};
	const onData = options.onData;
	const connection = new Connection(
		settingsOf({
			...options,
			onData: (message, session) => {
				received.push(message);
				return onData(message, session);
			},
		}),
		transport,
	);
	await connection.open();
	const greeting = output;
	return {
		connection,
		greeting,
		received,
		get ended() {
			return ended;
		},
		get tlsStarts() {
			return tlsStarts;
		},
		async send(text) {
			output = '';
			connection.receive(new TextEncoder().encode(text));
			await connection.idle();
			return output;
		},
	};
}

/** The base64 of `\0user\0password`, for AUTH PLAIN. */
export const plain = (user: string, password: string) =>
	new TextEncoder().encode(`\0${user}\0${password}`).toBase64();
