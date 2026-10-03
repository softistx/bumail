import { describe, expect, test } from 'bun:test';
import { imapOptions, loggedIn, seededStore } from '../server/session.fixtures';

async function session() {
	const { store, accountId } = await seededStore();
	return loggedIn(imapOptions(store, accountId));
}

const levels = (count: number) =>
	Array.from({ length: count }, (_, i) => `l${i}`).join('/');

describe('what one command may cost', () => {
	test('CREATE and RENAME: 32 levels at most, NO [LIMIT] past them', async () => {
		const s = await session();
		expect(await s.send(`a CREATE ${levels(32)}\r\n`)).toBe(
			'a OK CREATE completed\r\n',
		);
		expect(await s.send(`b CREATE ${levels(33)}\r\n`)).toBe(
			'b NO [LIMIT] A mailbox name has at most 32 levels\r\n',
		);
		expect(await s.send(`c RENAME Archive ${levels(33)}\r\n`)).toBe(
			'c NO [LIMIT] A mailbox name has at most 32 levels\r\n',
		);
		expect(await s.send(`d RENAME Archive ${levels(31)}/x\r\n`)).toBe(
			'd OK RENAME completed\r\n',
		);
	});

	test('CREATE and RENAME: 1024 characters at most', async () => {
		const s = await session();
		const long = Array.from({ length: 5 }, () => 'n'.repeat(205)).join('/');
		expect(long.length).toBe(1029);
		expect(await s.send(`a CREATE ${long}\r\n`)).toBe(
			'a NO [LIMIT] A mailbox name is at most 1024 characters\r\n',
		);
		expect(await s.send(`b RENAME Archive ${long}\r\n`)).toBe(
			'b NO [LIMIT] A mailbox name is at most 1024 characters\r\n',
		);
	});

	test('8000 levels are refused before the store is asked', async () => {
		const s = await session();
		const started = performance.now();
		expect(await s.send(`a CREATE ${'a/'.repeat(8000)}a\r\n`)).toStartWith(
			'a NO [LIMIT] ',
		);
		expect(await s.send('b LIST "" *\r\n')).not.toContain('"/" a');
		expect(performance.now() - started).toBeLessThan(500);
	});

	test('LIST: 16 patterns at most, BAD past them', async () => {
		const s = await session();
		const patterns = (count: number) =>
			Array.from({ length: count }, () => '%').join(' ');
		expect(await s.send(`a LIST "" (${patterns(16)})\r\n`)).toEndWith(
			'a OK LIST completed\r\n',
		);
		expect(await s.send(`b LIST "" (${patterns(17)})\r\n`)).toBe(
			'b BAD More than 16 patterns in one LIST\r\n',
		);
	});

	test('LIST: 16 patterns of 1024 wildcards against long names, in well under a second', async () => {
		const s = await session();
		for (let i = 0; i < 20; i++) {
			const name = Array.from({ length: 5 }, () => 'b'.repeat(200)).join('/');
			await s.send(`c${i} CREATE ${i}${name}\r\n`);
		}
		const pattern = `"${'*%'.repeat(511)}x"`;
		const patterns = Array.from({ length: 16 }, () => pattern).join(' ');
		const started = performance.now();
		expect(await s.send(`a LIST "" (${patterns})\r\n`)).toBe(
			'a OK LIST completed\r\n',
		);
		expect(performance.now() - started).toBeLessThan(500);
	});

	test('SEARCH: 32 TEXT or BODY keys at most', async () => {
		const s = await session();
		await s.send('a SELECT INBOX\r\n');
		const keys = (count: number) => 'TEXT x BODY y '.repeat(count / 2).trim();
		expect(await s.send(`b SEARCH ${keys(32)}\r\n`)).toEndWith(
			'b OK SEARCH completed\r\n',
		);
		expect(await s.send(`c SEARCH OR ${keys(32)} TEXT z\r\n`)).toBe(
			'c BAD More than 32 TEXT or BODY keys in one SEARCH\r\n',
		);
	});

	test('IMAP4rev1 SELECT says the first unseen message (RFC 3501 §6.3.1)', async () => {
		const s = await session();
		expect(await s.send('a SELECT INBOX\r\n')).toContain(
			'* OK [UNSEEN 1] Message 1 is first unseen\r\n',
		);
		await s.send('b STORE 1 +FLAGS.SILENT (\\Seen)\r\n');
		expect(await s.send('c SELECT INBOX\r\n')).toContain(
			'* OK [UNSEEN 2] Message 2 is first unseen\r\n',
		);
		await s.send('d STORE 2 +FLAGS.SILENT (\\Seen)\r\n');
		expect(await s.send('e SELECT INBOX\r\n')).not.toContain('UNSEEN');
	});
});
