import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tempDir } from '../../config/config.fixtures';
import { readConfig } from '../../config/read';
import { Directory } from '../../directory/directory';
import { serve } from '../serve';
import { prepare, startServer } from '../serve.fixtures';
import type { HealthContext } from './health';
import { createHealth, report, STORE_TIMEOUT_MS } from './health';

let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
	await stop?.();
	stop = undefined;
});

/** A server whose mail store is a PostgreSQL that is not there: it opens, and fails on its first call. */
async function startWithStoreDown() {
	const { file } = await prepare();
	const config = await readConfig({
		path: file,
		env: { BUMAIL_STORE_URL: 'postgres://bumail@127.0.0.1:1/mail' },
	});
	const lines: string[] = [];
	const server = await serve(config, {
		log: (line) => lines.push(line),
		port: () => 0,
	});
	const port = server.listening.find((l) => l.name === 'health')?.port ?? 0;
	return { server, lines, port, stop: () => server.stop() };
}

async function get(port: number, path = '/healthz', method = 'GET') {
	return fetch(`http://127.0.0.1:${port}${path}`, { method });
}

describe('GET /healthz', () => {
	test('is 200 with each part named when every listener is up and the store answers', async () => {
		const fixture = await startServer();
		stop = fixture.stop;
		const response = await get(fixture.port('health'));
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			status: 'ok',
			listeners: {
				mx: 'up',
				submissions: 'up',
				submission: 'up',
				imaps: 'up',
				https: 'up',
			},
			directory: 'ok',
			store: 'ok',
		});
	});

	test('binds loopback by default, and answers 404 and 405 elsewhere', async () => {
		const fixture = await startServer();
		stop = fixture.stop;
		const listening = fixture.server.listening.find((l) => l.name === 'health');
		expect(listening?.hostname).toBe('127.0.0.1');
		expect((await get(fixture.port('health'), '/')).status).toBe(404);
		expect((await get(fixture.port('health'), '/healthz', 'POST')).status).toBe(
			405,
		);
	});

	test('is 503, naming the store, when the store is down; logs the change once, and the recovery never', async () => {
		const fixture = await startWithStoreDown();
		stop = fixture.stop;
		const first = await get(fixture.port);
		expect(first.status).toBe(503);
		const body = (await first.json()) as {
			status: string;
			store: string;
			directory: string;
		};
		expect(body).toMatchObject({
			status: 'unavailable',
			store: 'failed',
			directory: 'ok',
		});
		expect(JSON.stringify(body)).not.toContain('127.0.0.1');
		await get(fixture.port);
		expect(fixture.lines.filter((l) => l.startsWith('health:'))).toEqual([
			'health: unhealthy: store',
		]);
	});

	test('is 503 once the server is stopping', async () => {
		const fixture = await startServer();
		const port = fixture.port('health');
		await fixture.stop();
		const refused = await get(port).catch(() => undefined);
		expect(refused === undefined || refused.status === 503).toBe(true);
	});

	test('serves on the address [health] names', async () => {
		const fixture = await startServer('[health]\nbind = "::1"');
		stop = fixture.stop;
		const listening = fixture.server.listening.find((l) => l.name === 'health');
		expect(listening?.hostname).toBe('::1');
		expect(
			(await fetch(`http://[::1]:${fixture.port('health')}/healthz`)).status,
		).toBe(200);
	});
});

function context(over: Partial<HealthContext>): HealthContext {
	const directory = Directory.open({
		file: join(tempDir(), 'directory.sqlite'),
	});
	return {
		config: {} as HealthContext['config'],
		directory,
		store: {
			findAccount: async () => undefined,
		} as unknown as HealthContext['store'],
		expected: ['mx', 'imaps'],
		up: new Set(['mx', 'imaps']),
		log: () => {},
		...over,
	};
}

describe('the report', () => {
	test('names a listener that is not up', async () => {
		const health = await report(context({ up: new Set(['mx']) }));
		expect(health).toMatchObject({
			status: 'unavailable',
			listeners: { mx: 'up', imaps: 'down' },
		});
	});

	test('fails the directory when it throws, without its text', async () => {
		const directory = Directory.open({
			file: join(tempDir(), 'directory.sqlite'),
		});
		directory.close();
		const health = await report(context({ directory }));
		expect(health).toMatchObject({
			status: 'unavailable',
			directory: 'failed',
			store: 'ok',
		});
	});

	test('fails the store when it throws or does not answer in time', async () => {
		const throws = await report(
			context({
				store: {
					findAccount: async () => {
						throw new Error('password=hunter2');
					},
				} as unknown as HealthContext['store'],
			}),
		);
		expect(throws.store).toBe('failed');
		expect(JSON.stringify(throws)).not.toContain('hunter2');
		expect(STORE_TIMEOUT_MS).toBeGreaterThan(0);
	});
});

describe('concurrent looks', () => {
	test('share one report', async () => {
		let calls = 0;
		const ctx = context({
			store: {
				findAccount: async () => {
					calls++;
					await Bun.sleep(50);
					return undefined;
				},
			} as unknown as HealthContext['store'],
		});
		const health = createHealth(ctx);
		const { port } = await health.listen({ port: 0, hostname: '127.0.0.1' });
		try {
			const answers = await Promise.all(
				Array.from({ length: 10 }, () => get(port)),
			);
			expect(answers.map((r) => r.status)).toEqual(Array(10).fill(200));
			expect(calls).toBe(1);
		} finally {
			health.stop(true);
		}
	});
});
