import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MailStore, MemoryMailStore } from '@bumail/store';
import { SqliteMailStore } from '@bumail/store/sqlite';
import { imapOptions, loggedIn, seededStore } from '../server/session.fixtures';

const directories: string[] = [];
const stores: SqliteMailStore[] = [];
afterAll(() => {
	for (const store of stores) store.close();
	for (const directory of directories) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function sqlite(): MailStore {
	const directory = mkdtempSync(join(tmpdir(), 'bumail-imap-'));
	directories.push(directory);
	const store = SqliteMailStore.open({ directory });
	stores.push(store);
	return store;
}

const answers: [string, () => MailStore][] = [
	['MemoryMailStore', () => new MemoryMailStore()],
	['SqliteMailStore', sqlite],
];

/**
 * RFC 9051 §2.3.2: keywords compare without case, but a client looks for
 * the one it set — Thunderbird's `$Forwarded` and `$MDNSent`, Apple Mail's
 * `$Junk`, `$NotJunk` and `NonJunk`. The server keeps the case a keyword
 * was first stored with, and never lists one twice.
 */
for (const [name, create] of answers) {
	describe(`keywords keep their case, on ${name}`, () => {
		async function selected() {
			const { store, accountId } = await seededStore(create());
			const s = await loggedIn(imapOptions(store, accountId));
			await s.send('s SELECT INBOX\r\n');
			return s;
		}

		test('STORE returns a keyword as it was set; another case is the same keyword', async () => {
			const s = await selected();
			expect(await s.send('a STORE 1 +FLAGS ($Forwarded $MDNSent)\r\n')).toBe(
				'* 1 FETCH (FLAGS ($Forwarded $MDNSent))\r\na OK STORE completed\r\n',
			);
			// The same keywords: the flags stay as first stored.
			expect(await s.send('b STORE 1 +FLAGS ($forwarded $MDNSENT)\r\n')).toBe(
				'* 1 FETCH (FLAGS ($Forwarded $MDNSent))\r\nb OK STORE completed\r\n',
			);
			expect(await s.send('c FETCH 1 FLAGS\r\n')).toBe(
				'* 1 FETCH (FLAGS ($Forwarded $MDNSent))\r\nc OK FETCH completed\r\n',
			);
			expect(await s.send('d STORE 1 -FLAGS ($FORWARDED)\r\n')).toBe(
				'* 1 FETCH (FLAGS ($MDNSent))\r\nd OK STORE completed\r\n',
			);
			expect(await s.send('e STORE 1 FLAGS ($Junk NonJunk $junk)\r\n')).toBe(
				'* 1 FETCH (FLAGS ($Junk NonJunk))\r\ne OK STORE completed\r\n',
			);
		});

		test('SEARCH KEYWORD and UNKEYWORD match whatever the case', async () => {
			const s = await selected();
			await s.send('a STORE 2 +FLAGS ($NotJunk)\r\n');
			expect(await s.send('b SEARCH KEYWORD $notjunk\r\n')).toBe(
				'* SEARCH 2\r\nb OK SEARCH completed\r\n',
			);
			expect(await s.send('c SEARCH KEYWORD $NOTJUNK\r\n')).toBe(
				'* SEARCH 2\r\nc OK SEARCH completed\r\n',
			);
			expect(await s.send('d SEARCH UNKEYWORD $NotJunk\r\n')).toBe(
				'* SEARCH 1\r\nd OK SEARCH completed\r\n',
			);
		});

		test('FLAGS and PERMANENTFLAGS list a keyword once, in its stored case', async () => {
			const s = await selected();
			await s.send('a STORE 1 +FLAGS ($Forwarded)\r\n');
			await s.send('b STORE 2 +FLAGS ($forwarded)\r\n');
			const reply = await s.send('c SELECT INBOX\r\n');
			expect(reply).toContain(
				'* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft $Forwarded)\r\n',
			);
			expect(reply).toContain(
				'* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft $Forwarded \\*)] Flags permitted\r\n',
			);
		});
	});
}
