import { afterEach, describe, expect, test } from 'bun:test';
import { type Queue, QueueError } from '@bumail/queue';
import type { SmtpServer } from '@bumail/smtp';
import { MemoryMailStore } from '@bumail/store';
import { selfSigned } from '../config/certificates.fixtures';
import { tempDir } from '../config/config.fixtures';
import type { Directory } from '../directory/directory';
import { seededDirectory } from '../directory/directory.fixtures';
import { Spool } from './spool';
import { createSubmission } from './submission';
import { letter, session, submit } from './submission.fixtures';

/** A queue that records what it is asked: `enqueue` as `enqueued` says, then `cancel`. */
function fakeQueue(enqueued: () => Promise<{ id: string }>) {
	const calls: string[] = [];
	const queue = {
		async enqueue(content: ReadableStream<Uint8Array>) {
			await new Response(content).arrayBuffer();
			const item = await enqueued();
			calls.push(`enqueue ${item.id}`);
			return item;
		},
		async cancel(id: string) {
			calls.push(`cancel ${id}`);
			return undefined;
		},
	} as unknown as Queue;
	return { queue, calls };
}

let server: SmtpServer | undefined;
let directory: Directory | undefined;

afterEach(() => {
	server?.stop(true);
	directory?.close();
	server = undefined;
	directory = undefined;
});

async function start(
	queue: Queue,
	store = new MemoryMailStore(),
): Promise<{ port: number; lines: string[] }> {
	directory = await seededDirectory();
	const lines: string[] = [];
	server = createSubmission(
		{
			hostname: 'mail.example.com',
			directory,
			store,
			submission: {
				maxMessageSize: 1 << 20,
				maxRecipients: 10,
				maxConnections: 10,
				maxConnectionsPerClient: 10,
				handshakeTimeout: 10,
			},
			postmaster: undefined,
			tls: await selfSigned(['localhost']),
			spool: Spool.open(tempDir(), 1 << 24),
			queue,
			sign: async (_, message) => {
				await message.cancel();
				return undefined;
			},
			log: (line) => lines.push(line),
			onDelivered: () => {},
			track: (work) => work,
			describe: (error) =>
				error instanceof Error ? error.message : String(error),
		},
		'submissions',
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return { port, lines };
}

describe('submission: handing on', () => {
	test('a store that fails after the queue took the remote part cancels the queued item', async () => {
		const store = new MemoryMailStore();
		store.addMessage = () => Promise.reject(new Error('the store is down'));
		const { queue, calls } = fakeQueue(async () => ({ id: 'q1' }));
		const { port, lines } = await start(queue, store);
		const client = await session(port, true, 'alice@example.com');
		const { last } = await submit(
			client,
			'alice@example.com',
			['carol@elsewhere.example', 'bob@example.com'],
			letter('alice@example.com', 'carol@elsewhere.example', 'both'),
		);
		client.end();
		// Told to send it again: the queue must not keep a copy meanwhile.
		expect(last).toMatch(/^4\d\d /);
		expect(calls).toEqual(['enqueue q1', 'cancel q1']);
		expect(
			lines.some((l) => /queued as q1, cancelled: it is not taken$/.test(l)),
		).toBe(true);
	});

	test('a cancel that fails is logged, and the reply is still a retry', async () => {
		const store = new MemoryMailStore();
		store.addMessage = () => Promise.reject(new Error('the store is down'));
		const { queue } = fakeQueue(async () => ({ id: 'q2' }));
		queue.cancel = () => Promise.reject(new Error('the queue is down'));
		const { port, lines } = await start(queue, store);
		const client = await session(port, true, 'alice@example.com');
		const { last } = await submit(
			client,
			'alice@example.com',
			['carol@elsewhere.example', 'bob@example.com'],
			letter('alice@example.com', 'carol@elsewhere.example', 'both'),
		);
		client.end();
		expect(last).toMatch(/^4\d\d /);
		expect(
			lines.some((l) =>
				/queued as q2, not cancelled: the queue is down; the retry may send it twice$/.test(
					l,
				),
			),
		).toBe(true);
	});

	test.each([
		['QUEUE_FULL', '452 4.3.1 The queue is full, try again later'],
		['MESSAGE_TOO_BIG', '552 5.3.4 Message too big for the queue'],
		['TOO_MANY_RECIPIENTS', '452 4.5.3 Too many recipients'],
		['CLOSED', '451 4.3.0 Message not taken'],
	] as const)('a queue refusing with %s answers %s', async (code, answer) => {
		const { queue } = fakeQueue(() =>
			Promise.reject(new QueueError(code, 'refused')),
		);
		const { port, lines } = await start(queue);
		const client = await session(port, true, 'alice@example.com');
		const { last } = await submit(
			client,
			'alice@example.com',
			['carol@elsewhere.example'],
			letter('alice@example.com', 'carol@elsewhere.example', 'refused'),
		);
		client.end();
		expect(last).toStartWith(answer);
		expect(lines.some((l) => l.endsWith('not queued: refused'))).toBe(true);
	});
});
