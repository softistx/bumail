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

	test('CREATE and RENAME: 255 characters a level, refused before any parent is made', async () => {
		const s = await session();
		const long = `p1/p2/${'n'.repeat(256)}`;
		const refused =
			'NO [LIMIT] A level of a mailbox name is at most 255 characters\r\n';
		expect(await s.send(`a CREATE ${long}\r\n`)).toBe(`a ${refused}`);
		expect(await s.send(`b RENAME Archive ${long}\r\n`)).toBe(`b ${refused}`);
		expect(await s.send('c LIST "" p1*\r\n')).toBe('c OK LIST completed\r\n');
		expect(await s.send(`d CREATE p1/p2/${'n'.repeat(255)}\r\n`)).toBe(
			'd OK CREATE completed\r\n',
		);
	});

	test('CREATE and RENAME: a level padded or all white space is refused before any parent is made', async () => {
		const s = await session();
		const refused =
			'NO [CANNOT] A level of a mailbox name cannot begin or end with white space\r\n';
		expect(await s.send('a CREATE "p1/ /x"\r\n')).toBe(`a ${refused}`);
		expect(await s.send('b CREATE "p2/ y/x"\r\n')).toBe(`b ${refused}`);
		// A tab and a no-break space, in modified UTF-7: the store trims both.
		expect(await s.send('c CREATE p3/y&AAk-/x\r\n')).toBe(`c ${refused}`);
		expect(await s.send('c2 CREATE p6/&AKA-y/x\r\n')).toBe(`c2 ${refused}`);
		expect(await s.send('d CREATE " p4/x"\r\n')).toBe(`d ${refused}`);
		expect(await s.send('e CREATE "p5/x "\r\n')).toBe(`e ${refused}`);
		expect(await s.send('f RENAME Archive "t1/ /y"\r\n')).toBe(`f ${refused}`);
		expect(await s.send('g RENAME Archive "t2/y / z"\r\n')).toBe(
			`g ${refused}`,
		);
		const list = await s.send('h LIST "" *\r\n');
		expect(list).not.toMatch(/"\/" "?(p\d|t\d| p4)/);
		expect(list).toContain('"/" Archive\r\n');
		expect(list).toEndWith('h OK LIST completed\r\n');
		expect(await s.send('i CREATE "p1/a b/x"\r\n')).toBe(
			'i OK CREATE completed\r\n',
		);
		expect(await s.send('j LIST "" p1*\r\n')).toBe(
			'* LIST (\\HasChildren) "/" p1\r\n* LIST (\\HasChildren) "/" "p1/a b"\r\n* LIST (\\HasNoChildren) "/" "p1/a b/x"\r\nj OK LIST completed\r\n',
		);
	});

	test('CREATE and RENAME: a control character is refused before any parent is made', async () => {
		const s = await session();
		const refused =
			'NO [CANNOT] A mailbox name cannot hold a control character\r\n';
		expect(await s.send('a CREATE p1/&AAE-/x\r\n')).toBe(`a ${refused}`);
		expect(await s.send('b RENAME Archive t1/y&AAk-z/w\r\n')).toBe(
			`b ${refused}`,
		);
		expect(await s.send('c ENABLE IMAP4rev2\r\n')).toContain('c OK ');
		expect(await s.send('c1 CREATE {7+}\r\np2/\x01y/x\r\n')).toBe(
			`c1 ${refused}`,
		);
		expect(await s.send('c2 RENAME Archive {6+}\r\nt2/\x7f/y\r\n')).toBe(
			`c2 ${refused}`,
		);
		expect(await s.send('d LIST "" *\r\n')).not.toMatch(/"\/" (p\d|t\d)/);
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
