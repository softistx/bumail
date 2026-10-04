import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixtureResolver } from '@bumail/dns';
import { readConfig } from '../config/read';
import { type Sink, startSink } from './outbound.fixtures';
import { serve } from './serve';
import { type Fixture, mailOf, RECORDS, startServer } from './serve.fixtures';
import { letter, logged, session, submit } from './submission.fixtures';

let fixture: Fixture | undefined;
const sinks: Sink[] = [];

afterEach(async () => {
	await fixture?.stop();
	fixture = undefined;
	for (const sink of sinks.splice(0)) sink.stop();
});

/** The DNS of `remote.example`: its MX on this machine. */
const REMOTE = {
	...RECORDS,
	'remote.example': { mx: [{ exchange: 'mx.remote.example', priority: 10 }] },
	'mx.remote.example': { a: ['127.0.0.1'] },
};

/** The server, its queue delivering by MX to `sink`, looking every 50 ms. */
async function start(sink: Sink, extra = ''): Promise<Fixture> {
	fixture = await startServer(extra, {
		resolver: fixtureResolver(REMOTE),
		outbound: { mxPort: sink.port, pollInterval: 50, ca: sink.cert },
	});
	return fixture;
}

async function sink(...args: Parameters<typeof startSink>): Promise<Sink> {
	const started = await startSink(...args);
	sinks.push(started);
	return started;
}

/** Alice sends `to` a message, over 465. */
async function send(f: Fixture, to: readonly string[], subject: string) {
	const client = await session(
		f.port('submissions'),
		true,
		'alice@example.com',
	);
	const result = await submit(
		client,
		'alice@example.com',
		to,
		letter('alice@example.com', to[0] ?? '', subject),
	);
	await client.smtp('QUIT');
	client.end();
	return result;
}

describe('outbound: by MX', () => {
	test('queues mail for another domain, then delivers it to its MX', async () => {
		const mx = await sink();
		const f = await start(mx);
		const { last } = await send(
			f,
			['carol@remote.example', 'bob@example.com'],
			'out and in',
		);
		expect(last).toStartWith('250 ');
		const [taken] = await mx.until(1);
		expect(taken?.from).toBe('alice@example.com');
		expect(taken?.to).toEqual(['carol@remote.example']);
		expect(taken?.text).toContain('Subject: out and in\r\n');
		expect(taken?.text).not.toContain('Return-Path:');
		await logged(
			f.lines,
			/^outbound: \S+ <alice@example\.com> delivered to carol@remote\.example by mx\.remote\.example$/,
		);
		expect(
			f.lines.some((l) =>
				/^submissions: \S+ from alice@example\.com <alice@example\.com> queued as \S+ for carol@remote\.example; delivered to bob@example\.com|delivered to bob@example\.com; queued as \S+ for carol@remote\.example/.test(
					l,
				),
			),
		).toBe(true);
		const [mail = ''] = await mailOf(
			await (async () => {
				await f.stop();
				fixture = undefined;
				return f.dir;
			})(),
			'bob@example.com',
			'inbox',
		);
		expect(mail).toContain('Subject: out and in');
	});

	test('a permanent failure sends a DSN to the sender’s own mailbox, never out', async () => {
		const mx = await sink();
		const f = await start(mx);
		const { replies, last } = await send(
			f,
			['nobody@remote.example'],
			'bounce me',
		);
		expect(replies[1]).toStartWith('250');
		expect(last).toStartWith('250 ');
		await logged(
			f.lines,
			/^outbound: \S+ to nobody@remote\.example failed: 550 5\.1\.1/,
		);
		await logged(
			f.lines,
			/^outbound: \S+: a failed DSN to <alice@example\.com> queued as \S+$/,
		);
		await logged(
			f.lines,
			/^outbound: \S+ <> delivered to alice@example\.com by mail\.example\.com$/,
		);
		await f.stop();
		fixture = undefined;
		// The sink took nothing: not the message, not the DSN.
		expect(mx.taken).toEqual([]);
		const [dsn = ''] = await mailOf(f.dir, 'alice@example.com', 'inbox');
		expect(dsn).toStartWith('Return-Path: <>\r\n');
		expect(dsn).toContain('multipart/report');
		expect(dsn).toContain('nobody@remote.example');
		expect(dsn).toContain('Subject: bounce me');
	});
});

describe('outbound: through a smarthost', () => {
	test('logs in to the smarthost over STARTTLS and hands it everything', async () => {
		const relay = await sink({
			username: 'relay',
			password: 'relay-password-1',
		});
		const unused = await sink();
		const f = await start(
			unused,
			[
				'[smarthost]',
				'host = "127.0.0.1"',
				`port = ${relay.port}`,
				'username = "relay"',
				'password = "relay-password-1"',
			].join('\n'),
		);
		const { last } = await send(f, ['carol@remote.example'], 'via relay');
		expect(last).toStartWith('250 ');
		const [taken] = await relay.until(1);
		expect(taken?.user).toBe('relay');
		expect(taken?.to).toEqual(['carol@remote.example']);
		expect(unused.taken).toEqual([]);
	});
});

describe('outbound: the stop', () => {
	test('waits for a delivery under way, and keeps what was queued during the drain for the next start', async () => {
		const mx = await sink(undefined, { delayMs: 1000 });
		const f = await start(mx);
		const options = {
			resolver: fixtureResolver(REMOTE),
			outbound: { mxPort: mx.port, pollInterval: 50 },
			port: () => 0,
		};
		expect((await send(f, ['carol@remote.example'], 'first')).last).toStartWith(
			'250 ',
		);
		// The queue claims it at once, and the sink holds it a second.
		await Bun.sleep(300);
		const client = await session(
			f.port('submission'),
			false,
			'alice@example.com',
		);
		await client.smtp('MAIL FROM:<alice@example.com>');
		await client.smtp('RCPT TO:<dave@remote.example>');
		await client.smtp('DATA');
		const text = letter('alice@example.com', 'dave@remote.example', 'second');
		client.write(text.slice(0, 40));
		const stopping = f.server.stop();
		await Bun.sleep(100);
		client.write(`${text.slice(40)}\r\n.\r\n`);
		expect(await client.reply()).toStartWith('250 ');
		await client.smtp('QUIT');
		await stopping;
		fixture = undefined;
		const delivered = f.lines.findIndex((l) =>
			/^outbound: \S+ <alice@example\.com> delivered to carol@remote\.example/.test(
				l,
			),
		);
		expect(delivered).toBeGreaterThan(-1);
		expect(delivered).toBeLessThan(f.lines.indexOf('bumail: stopped'));
		expect(mx.taken.map((t) => t.to)).toEqual([['carol@remote.example']]);

		// The next start delivers what the drain queued.
		const lines: string[] = [];
		const again = await serve(
			await readConfig({ path: join(f.dir, 'bumail.toml'), env: {} }),
			{ ...options, log: (line) => lines.push(line) },
		);
		try {
			await logged(lines, /delivered to dave@remote\.example/);
			expect(mx.taken).toHaveLength(2);
		} finally {
			await again.stop();
		}
	}, 30_000);
});
