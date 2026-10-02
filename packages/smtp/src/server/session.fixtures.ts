import { Connection } from './connection';
import type { Envelope, ReceivedMessage, SmtpServerOptions } from './options';
import { settingsOf } from './settings';
import type { Transport } from './transport';

/** A message `onData` read to its end. */
export interface ReadMessage {
	readonly id: string;
	readonly envelope: Envelope;
	readonly content: Uint8Array<ArrayBuffer>;
	readonly text: string;
}

/** A session on a fake socket: what the client sends, what the server answered. */
export interface FakeSession {
	readonly connection: Connection;
	/** What the server said on connecting. */
	readonly greeting: string;
	/** Messages `onData` read to the end of a stream that did not error. */
	readonly received: ReadMessage[];
	/** Errors handed to `onError`. */
	readonly errors: unknown[];
	/** Sends text, waits for every reply to it, and returns them. */
	send(text: string): Promise<string>;
	/** Whether the server hung up. */
	readonly ended: boolean;
	/** Times the server started TLS. */
	readonly tlsStarts: number;
	/** Whether the server paused reading. */
	readonly paused: boolean;
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

/** For specs only: what STARTTLS and AUTH need to be offered. */
export const FAKE_TLS = { key: 'fake', cert: 'fake' };

/** Reads a message's content to its end; throws what the stream errors with. */
export async function readContent(
	message: ReceivedMessage,
): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await new Response(message.content).arrayBuffer());
}

export async function fakeSession(
	options: SmtpServerOptions,
	{
		secure = false,
		remoteAddress = '192.0.2.10',
		/** Text the client sends before the greeting. */
		early = '',
		/** Hands `onData` the stream itself, instead of reading it first. */
		raw = false,
	} = {},
): Promise<FakeSession> {
	const received: ReadMessage[] = [];
	const errors: unknown[] = [];
	let output = '';
	let ended = false;
	let tlsStarts = 0;
	let paused = false;
	let encrypted = secure;
	const transport: Transport = {
		remoteAddress,
		get secure() {
			return encrypted;
		},
		write: (text) => {
			output += text;
		},
		drained: () => Promise.resolve(),
		end: () => {
			ended = true;
		},
		pause: () => {
			paused = true;
		},
		resume: () => {
			paused = false;
		},
		startTls: () => {
			tlsStarts++;
			encrypted = true;
		},
	};
	const { onData, onError } = options;
	const connection = new Connection(
		settingsOf({
			...options,
			// By default, the fake app reads every message to its end, as onData must.
			onData: async (message, session) => {
				if (raw) return onData(message, session);
				const content = await readContent(message);
				received.push({
					id: message.id,
					envelope: message.envelope,
					content,
					text: new TextDecoder().decode(content),
				});
				return onData(
					{ ...message, content: new Blob([content]).stream() },
					session,
				);
			},
			onError: (error, session) => {
				errors.push(error);
				onError?.(error, session);
			},
		}),
		transport,
	);
	const opening = connection.open();
	if (early) connection.receive(new TextEncoder().encode(early));
	await opening;
	const greeting = output;
	return {
		connection,
		greeting,
		received,
		errors,
		get ended() {
			return ended;
		},
		get tlsStarts() {
			return tlsStarts;
		},
		get paused() {
			return paused;
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
