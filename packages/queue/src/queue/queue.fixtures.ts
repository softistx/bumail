import type {
	MxResolver,
	Reply,
	SendMailOptions,
	SendMailResult,
} from '@bumail/smtp/client';
import { MemoryQueueStore } from '../memory/store';
import type { QueueEvents } from './events';
import type { QueueOptions, Sender } from './options';
import { createQueue } from './queue';

export const T0 = Date.UTC(2026, 9, 1, 12);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const MESSAGE =
	'From: mary@example.net\r\nTo: joe@example.com\r\nSubject: Hi\r\n\r\nHello\r\n';

/** A clock that moves only when told. */
export function fakeClock(start = T0) {
	let now = start;
	return {
		now: () => now,
		advance(ms: number) {
			now += ms;
		},
	};
}

/** A resolver nobody asks: a fake sender does not look anything up. */
export const NO_DNS: MxResolver = {
	mx: async () => [],
	a: async () => [],
	aaaa: async () => [],
};

export const reply = (code: number, status: string, text: string): Reply => ({
	code,
	status,
	text,
});

const recipientsOf = (options: SendMailOptions) =>
	typeof options.to === 'string' ? [options.to] : [...options.to];

/** What a server that took every recipient answers. */
export function accepted(
	options: SendMailOptions,
	refused: Readonly<Record<string, Reply>> = {},
): SendMailResult {
	const to = recipientsOf(options);
	const ok = reply(250, '2.1.5', 'OK');
	return {
		accepted: to
			.filter((r) => !refused[r])
			.map((recipient) => ({ recipient, reply: ok })),
		rejected: to
			.filter((r) => refused[r])
			.map((recipient) => ({ recipient, reply: refused[recipient] as Reply })),
		reply: reply(250, '2.0.0', 'Queued as 42'),
		host: 'mx.example.com',
		port: 25,
		tls: { verified: false },
		authenticated: false,
	};
}

/** One call to the fake sender. */
export interface Call {
	readonly options: SendMailOptions;
	readonly to: string[];
	readonly text: string;
}

/** What the fake sender does for a call: a result, or an error it throws. */
export type Script = (
	call: Call,
	index: number,
) => SendMailResult | Error | Promise<SendMailResult | Error>;

/** A sender that records each call and answers by the script: accepting everyone by default. */
export function fakeSender(script: Script = (call) => accepted(call.options)) {
	const calls: Call[] = [];
	const send: Sender = async (message, options) => {
		const call = {
			options,
			to: recipientsOf(options),
			text: new TextDecoder().decode(message),
		};
		calls.push(call);
		const out = await script(call, calls.length - 1);
		if (out instanceof Error) throw out;
		return out;
	};
	return { send, calls };
}

/** Every event the queue emitted, by name. */
export function recordEvents(queue: ReturnType<typeof createQueue>) {
	const seen: { [E in keyof QueueEvents]: QueueEvents[E][] } = {
		delivered: [],
		deferred: [],
		failed: [],
		dsn: [],
		error: [],
	};
	for (const name of Object.keys(seen) as (keyof QueueEvents)[]) {
		queue.on(name, (event) => (seen[name] as unknown[]).push(event));
	}
	return seen;
}

/** Options over the defaults of `setup`; `resolver: undefined` leaves the resolver out. */
export type Overrides = Partial<Omit<QueueOptions, 'resolver'>> & {
	readonly resolver?: QueueOptions['resolver'] | undefined;
};

/** A queue on a memory store, a fake clock and a fake sender. */
export function setup(script?: Script, overrides: Overrides = {}) {
	const store = new MemoryQueueStore();
	const clock = fakeClock();
	const sender = fakeSender(script);
	const { resolver = 'resolver' in overrides ? undefined : NO_DNS, ...rest } =
		overrides;
	const queue = createQueue({
		store,
		hostname: 'mail.example.net',
		...(resolver ? { resolver } : {}),
		clock,
		send: sender.send,
		random: () => 0,
		...rest,
	});
	const events = recordEvents(queue);
	return { store, clock, sender, queue, events };
}

/** A promise opened by hand. */
export function gate() {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

/** Waits until `ready()`, a few seconds at most. */
export async function until(ready: () => boolean | Promise<boolean>) {
	for (let i = 0; i < 400; i++) {
		if (await ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('never ready');
}
