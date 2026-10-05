import { afterEach, describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { selfSigned } from '../config/certificates.fixtures';
import { tempDir } from '../config/config.fixtures';
import { type TlsTarget, type TlsWatch, watchTls } from './reload';
import type { TlsFiles } from './tls';

const NAMES = ['mail.example.com'];
let watch: TlsWatch | undefined;
afterEach(() => {
	watch?.stop();
	watch = undefined;
});

/** Files on disk, a watch over them and fake listeners that record the pairs they were given. */
async function setup(
	options: {
		pollSeconds?: number;
		failing?: string;
		/** A listener whose rollback fails too. */
		stubborn?: string;
		held?: string[];
		now?: () => Date;
	} = {},
) {
	const dir = tempDir();
	const files = { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') };
	const first = await selfSigned(NAMES);
	await Bun.write(files.cert, first.cert);
	await Bun.write(files.key, first.key);
	const lines: string[] = [];
	const given: Record<string, TlsFiles[]> = { a: [], b: [] };
	const targets: TlsTarget[] = ['a', 'b'].map((name) => ({
		name,
		async setTls(tls) {
			if (name === options.failing && tls.cert !== first.cert) {
				throw new Error('cannot bind');
			}
			if (name === options.stubborn && given[name]?.length) {
				throw new Error('stuck');
			}
			given[name]?.push(tls);
		},
	}));
	watch = watchTls({
		files: { ...files, pollSeconds: options.pollSeconds ?? 0 },
		hostname: 'mail.example.com',
		applied: first,
		targets,
		...(options.held ? { held: options.held } : {}),
		log: (line) => lines.push(line),
		describe: (error) => (error as Error).message,
		...(options.now ? { now: options.now } : {}),
	});
	const write = async (pair: { cert?: string; key?: string }) => {
		if (pair.cert !== undefined) await Bun.write(files.cert, pair.cert);
		if (pair.key !== undefined) await Bun.write(files.key, pair.key);
	};
	return { watch, lines, given, first, files, write };
}

describe('watchTls', () => {
	test('a renewed pair goes to every listener, and is logged with its subject and expiry', async () => {
		const s = await setup();
		const renewed = await selfSigned(NAMES, {
			notAfter: new Date('2031-05-06T00:00:00Z'),
		});
		await s.write(renewed);
		await s.watch.reload();
		expect(s.given['a']).toEqual([renewed]);
		expect(s.given['b']).toEqual([renewed]);
		expect(s.lines).toEqual([
			'tls: reloaded (CN=mail.example.com, expires 2031-05-06)',
		]);
	});

	test('a key written before its certificate is not applied half-way', async () => {
		const s = await setup();
		const renewed = await selfSigned(NAMES);
		await s.write({ key: renewed.key });
		await s.watch.reload();
		expect(s.given['a']).toEqual([]);
		expect(s.lines).toEqual([
			'tls: not reloaded: tls.key is not the key of tls.cert',
		]);
		await s.write({ cert: renewed.cert });
		await s.watch.reload();
		expect(s.given['a']).toEqual([renewed]);
		expect(s.lines[1]).toStartWith('tls: reloaded (CN=mail.example.com');
	});

	test('a pair that is not valid is refused, with the reason and no secret', async () => {
		const s = await setup();
		const other = await selfSigned(['elsewhere.example.org']);
		await s.write(other);
		await s.watch.reload();
		const expired = await selfSigned(NAMES, {
			notBefore: new Date('2020-01-01T00:00:00Z'),
			notAfter: new Date('2021-01-01T00:00:00Z'),
		});
		await s.write(expired);
		await s.watch.reload();
		await s.write({ cert: 'garbage' });
		await s.watch.reload();
		expect(s.lines).toEqual([
			'tls: not reloaded: tls.cert does not name mail.example.com (it names elsewhere.example.org)',
			'tls: not reloaded: tls.cert expired on 2021-01-01',
			'tls: not reloaded: tls.cert is not a PEM certificate',
		]);
		expect(s.given['a']).toEqual([]);
		expect(s.lines.join('\n')).not.toContain(expired.key.split('\n')[1] ?? '?');
	});

	test('a file that cannot be read is a reason, not a crash', async () => {
		const s = await setup();
		await Bun.file(s.files.key).delete();
		await s.watch.reload();
		expect(s.lines).toEqual([
			'tls: not reloaded: tls.key cannot be read (ENOENT)',
		]);
	});

	test('a listener that refuses puts the others back on the old pair', async () => {
		const s = await setup({ failing: 'b' });
		const renewed = await selfSigned(NAMES);
		await s.write(renewed);
		await s.watch.reload();
		expect(s.given['a']).toEqual([renewed, s.first]);
		expect(s.given['b']).toEqual([]);
		expect(s.lines).toEqual(['tls: not reloaded: b: cannot bind']);
	});

	test('a rollback that fails names the listener left on the new pair', async () => {
		const s = await setup({ failing: 'b', stubborn: 'a' });
		await s.write(await selfSigned(NAMES));
		await s.watch.reload();
		expect(s.lines).toEqual([
			'tls: not reloaded: b: cannot bind; a left on the new pair, the rollback failed',
		]);
	});

	test('a listener that keeps the old pair until a restart is named in the log line', async () => {
		const s = await setup({ held: ['https'] });
		await s.write(await selfSigned(NAMES));
		await s.watch.reload();
		expect(s.lines[0]).toEndWith(
			'; https keeps the old certificate until restart',
		);
	});

	test('SIGHUPs arriving while a look waits join it: one look, one line', async () => {
		const s = await setup();
		await s.write(await selfSigned(NAMES));
		const looks = [s.watch.reload(), s.watch.reload(), s.watch.reload()];
		await Promise.all(looks);
		expect(s.lines).toHaveLength(1);
		expect(s.given['a']).toHaveLength(1);
	});

	test('files that did not change say nothing when polled, and "unchanged" on a SIGHUP', async () => {
		const s = await setup();
		await s.watch.reload();
		await s.watch.reload();
		const expires = new Date(new X509Certificate(s.first.cert).validTo)
			.toISOString()
			.slice(0, 10);
		const line = `tls: unchanged (CN=mail.example.com, expires ${expires})`;
		expect(s.lines).toEqual([line, line]);
		expect(s.given['a']).toEqual([]);
	});
});

describe('watchTls polling', () => {
	test('looks every pollSeconds and logs once per change, never per look', async () => {
		const s = await setup({ pollSeconds: 1 });
		const renewed = await selfSigned(NAMES);
		// A broken state, seen by three looks: one line.
		await s.write({ key: renewed.key });
		await Bun.sleep(3300);
		expect(s.lines).toEqual([
			'tls: not reloaded: tls.key is not the key of tls.cert',
		]);
		await s.write({ cert: renewed.cert });
		await Bun.sleep(1500);
		expect(s.given['a']).toEqual([renewed]);
		// Applied, and three more looks: nothing.
		await Bun.sleep(3000);
		expect(s.lines).toHaveLength(2);
		expect(s.lines[1]).toStartWith('tls: reloaded (');
	}, 15_000);

	test('a rewrite of the same text is no change', async () => {
		const s = await setup({ pollSeconds: 1 });
		await s.write({ cert: s.first.cert, key: s.first.key });
		await Bun.sleep(2300);
		expect(s.lines).toEqual([]);
		expect(s.given['a']).toEqual([]);
	});

	test('after stop() it looks no more', async () => {
		const s = await setup({ pollSeconds: 1 });
		s.watch.stop();
		await s.write(await selfSigned(NAMES));
		await Bun.sleep(1500);
		expect(s.lines).toEqual([]);
	});
});
