import { describe, expect, test } from 'bun:test';
import { ACME, problemsOf, writeConfig } from './config.fixtures';
import { readConfig } from './read';

const HOST = 'hostname = "mail.example.com"\n';
const PG_CLEAR =
	'sends credentials without TLS; add sslmode=require (or verify-ca, verify-full), or sslmode=disable to send them in clear';
const REDIS_CLEAR =
	'sends credentials without TLS; use rediss:, or set insecure = true to send them in clear';
const REDIS_ONLY =
	'is only for a redis: URL that sends credentials to another host';

async function read(fragment: string, env: Record<string, string> = {}) {
	return readConfig({ path: writeConfig(`${HOST}${fragment}\n${ACME}`), env });
}

async function problems(fragment: string, env: Record<string, string> = {}) {
	return problemsOf(`${HOST}${fragment}\n${ACME}`, { env });
}

describe('PostgreSQL: TLS as Bun will connect', () => {
	test.each([
		['sslmode=require', 'sslmode=require'],
		['sslmode=verify-ca', 'sslmode=verify-ca'],
		['sslmode=verify-full', 'sslmode=verify-full'],
		['ssl=true', 'ssl=true'],
	])('takes %s', async (_, query) => {
		const config = await read(
			`[store]\nurl = "postgres://u:pw@db.internal/mail?${query}"`,
		);
		expect(config.store.plaintext).toBe(false);
	});

	test.each([
		['no sslmode', ''],
		['sslmode=prefer', '?sslmode=prefer'],
		['sslmode=allow', '?sslmode=allow'],
		['sslmode=require undone by ssl=false', '?sslmode=require&ssl=false'],
		['sslmode=require undone by tls=0', '?sslmode=require&tls=0'],
	])('refuses %s', async (_, query) => {
		const found = await problems(
			`[store]\nurl = "postgres://u:pw@db.internal/mail${query}"`,
		);
		expect(found.length).toBe(1);
		expect(found[0]).toStartWith('store.url: ');
	});

	test('refuses a repeated sslmode as Bun does', async () => {
		expect(
			await problems(
				'[store]\nurl = "postgres://u:pw@db.internal/mail?sslmode=require&sslmode=disable"',
			),
		).toEqual(['store.url: is not a PostgreSQL URL Bun.sql takes']);
	});

	test('counts PGPASSWORD as credentials, as Bun sends it', async () => {
		expect(
			await problems('[store]\nurl = "postgres://db.internal/mail"', {
				PGPASSWORD: 'pw',
			}),
		).toEqual([`store.url: ${PG_CLEAR}`]);
		const config = await read('[store]\nurl = "postgres://db.internal/mail"');
		expect(config.store.plaintext).toBe(false);
	});

	test('takes sslmode=disable as the operator’s choice, marked plaintext', async () => {
		const config = await read(
			'[store]\nurl = "postgres://u:pw@db.internal/mail?sslmode=disable"\n[queue]\nurl = "postgresql://u:pw@db.internal/mail?sslmode=disable"',
		);
		expect(config.store.plaintext).toBe(true);
		expect(config.queue.plaintext).toBe(true);
	});

	test('refuses insecure = true, which is Redis’s', async () => {
		expect(
			await problems(
				'[store]\nurl = "postgres://u:pw@db.internal/mail?sslmode=disable"\ninsecure = true',
			),
		).toEqual([
			'store.insecure: is only for a redis: URL; for PostgreSQL, write sslmode=disable in the URL',
		]);
	});
});

describe('Redis: insecure = true', () => {
	test('lets a redis: URL send credentials in clear, marked plaintext', async () => {
		const config = await read(
			'[queue]\nurl = "redis://:pw@cache.internal:6379"\ninsecure = true',
		);
		expect(config.queue).toEqual({
			url: 'redis://:pw@cache.internal:6379',
			plaintext: true,
		});
	});

	test('is needed for one', async () => {
		expect(
			await problems(
				'[queue]\nurl = "redis://:pw@cache.internal:6379"\ninsecure = false',
			),
		).toEqual([`queue.url: ${REDIS_CLEAR}`]);
	});

	test.each([
		[
			'rediss:',
			'[queue]\nurl = "rediss://:pw@cache.internal"\ninsecure = true',
		],
		[
			'a URL without credentials',
			'[queue]\nurl = "redis://cache.internal"\ninsecure = true',
		],
		['loopback', '[queue]\nurl = "redis://:pw@127.0.0.1"\ninsecure = true'],
		['SQLite', '[queue]\nurl = "sqlite:/data/queue"\ninsecure = true'],
		['the default store', '[store]\ninsecure = true'],
	])('is refused with %s', async (_, fragment) => {
		const section = fragment.startsWith('[store]') ? 'store' : 'queue';
		expect(await problems(fragment)).toEqual([
			`${section}.insecure: ${REDIS_ONLY}`,
		]);
	});

	test('is not a key of [directory]', async () => {
		expect(await problems('[directory]\ninsecure = true')).toEqual([
			'directory.insecure: unknown key',
		]);
	});

	test('?password= is refused: Bun ignores it', async () => {
		expect(
			await problems('[queue]\nurl = "redis://cache.internal?password=pw"'),
		).toEqual([
			'queue.url: takes its credentials before the host (redis://:password@host); Bun ignores ?password=',
		]);
	});
});

describe('Redis: credentials in the userinfo, in any form', () => {
	test.each([
		[
			'a user alone, which Bun sends as a password',
			'redis://s3cret@cache.internal',
		],
		['a colon encoded in the user', 'redis://user%3As3cret@cache.internal'],
		['a user and a password', 'redis://user:s3cret@cache.internal'],
	])('%s is refused in clear', async (_, url) => {
		expect(await problems(`[queue]\nurl = "${url}"`)).toEqual([
			`queue.url: ${REDIS_CLEAR}`,
		]);
	});
});

describe('the environment PostgreSQL reads is the one given', () => {
	const PG_KEYS = ['PGSSLMODE', 'PGPASSWORD', 'PGHOST'] as const;

	test('not the process’s, which is left as it was', async () => {
		const before = PG_KEYS.map((key) => process.env[key]);
		process.env['PGSSLMODE'] = 'require';
		process.env['PGPASSWORD'] = 'from-the-process';
		process.env['PGHOST'] = '127.0.0.1';
		try {
			expect(
				await problems('[store]\nurl = "postgres://u:pw@db.internal/mail"'),
			).toEqual([`store.url: ${PG_CLEAR}`]);
			const config = await read('[store]\nurl = "postgres://db.internal/mail"');
			expect(config.store.plaintext).toBe(false);
			expect(process.env['PGSSLMODE']).toBe('require');
			expect(process.env['PGPASSWORD']).toBe('from-the-process');
		} finally {
			PG_KEYS.forEach((key, i) => {
				const was = before[i];
				if (was === undefined) delete process.env[key];
				else process.env[key] = was;
			});
		}
	});

	test('PGSSLMODE given turns TLS on, as Bun will', async () => {
		const config = await read(
			'[store]\nurl = "postgres://u:pw@db.internal/mail"',
			{ PGSSLMODE: 'require' },
		);
		expect(config.store.plaintext).toBe(false);
	});

	test('PGHOST and PGPASSWORD given are where and what Bun sends', async () => {
		expect(
			await problems('[store]\nurl = "postgres:///mail"', {
				PGHOST: 'db.internal',
				PGPASSWORD: 'pw',
			}),
		).toEqual([`store.url: ${PG_CLEAR}`]);
		expect(
			(await read('[store]\nurl = "postgres:///mail"', { PGPASSWORD: 'pw' }))
				.store.plaintext,
		).toBe(false);
	});
});
