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
	/** Whether it hung up at once, its own decision, rather than gracefully after QUIT. */
	readonly aborted: boolean;
	/** Times the server started TLS. */
	readonly tlsStarts: number;
	/** Whether the server paused reading. */
	readonly paused: boolean;
	/** What the server had written when it restarted the idle time, each time. */
	readonly idleRestarts: readonly string[];
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
	message: Pick<ReceivedMessage, 'content'>,
): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await new Response(message.content).arrayBuffer());
}

/** A Transport that records what the server does with it. */
interface FakeTransport {
	readonly transport: Transport;
	/** What the server wrote since the last `take`. */
	take(): string;
	readonly ended: boolean;
	/** Hung up by `abort`, the server's decision, rather than `end`. */
	readonly aborted: boolean;
	readonly tlsStarts: number;
	readonly paused: boolean;
	readonly idleRestarts: readonly string[];
}

function fakeTransport(secure: boolean, remoteAddress: string): FakeTransport {
	let output = '';
	let ended = false;
	let aborted = false;
	let tlsStarts = 0;
	let paused = false;
	let encrypted = secure;
	let written = '';
	const idleRestarts: string[] = [];
	return {
		transport: {
			remoteAddress,
			get secure() {
				return encrypted;
			},
			write: (text) => {
				output += text;
				written += text;
			},
			drained: () => Promise.resolve(),
			end: () => {
				ended = true;
			},
			abort: () => {
				ended = true;
				aborted = true;
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
			restartIdle: () => {
				idleRestarts.push(written);
			},
		},
		take() {
			const taken = output;
			output = '';
			return taken;
		},
		get ended() {
			return ended;
		},
		get aborted() {
			return aborted;
		},
		get tlsStarts() {
			return tlsStarts;
		},
		get paused() {
			return paused;
		},
		idleRestarts,
	};
}

/**
 * The options as the fake session runs them: unless `raw`, `onData` gets
 * the message after the fake app read it to its end, as `onData` must, and
 * what it read is kept in `received`; errors are kept in `errors`.
 */
function recordingOptions(
	options: SmtpServerOptions,
	raw: boolean,
	received: ReadMessage[],
	errors: unknown[],
): SmtpServerOptions {
	const { onData, onError } = options;
	return {
		...options,
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
	};
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
	const fake = fakeTransport(secure, remoteAddress);
	const connection = new Connection(
		settingsOf(recordingOptions(options, raw, received, errors)),
		fake.transport,
	);
	const opening = connection.open();
	if (early) connection.receive(new TextEncoder().encode(early));
	await opening;
	const greeting = fake.take();
	return {
		connection,
		greeting,
		received,
		errors,
		get ended() {
			return fake.ended;
		},
		get aborted() {
			return fake.aborted;
		},
		get tlsStarts() {
			return fake.tlsStarts;
		},
		get paused() {
			return fake.paused;
		},
		idleRestarts: fake.idleRestarts,
		async send(text) {
			fake.take();
			connection.receive(new TextEncoder().encode(text));
			await connection.idle();
			return fake.take();
		},
	};
}

/** The base64 of `\0user\0password`, for AUTH PLAIN. */
export const plain = (user: string, password: string) =>
	new TextEncoder().encode(`\0${user}\0${password}`).toBase64();
