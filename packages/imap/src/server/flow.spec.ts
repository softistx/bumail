import { describe, expect, test } from 'bun:test';
import { imapOptions, loggedIn, SIMPLE, seededStore } from './session.fixtures';

/**
 * What Thunderbird and Apple Mail do on a first sync, end to end:
 * LIST, SELECT INBOX, FETCH, a body, \Seen, MOVE to Archive, EXPUNGE, IDLE.
 */
describe('a mail client’s first session', () => {
	test('LOGIN to IDLE', async () => {
		const { store, accountId, inbox } = await seededStore();
		const s = await loggedIn(
			imapOptions(store, accountId, { idleInterval: 0.05 }),
		);

		expect(await s.send('a LIST "" "*"\r\n')).toBe(
			'* LIST (\\HasNoChildren) "/" INBOX\r\n' +
				'* LIST (\\HasNoChildren \\Archive) "/" Archive\r\n' +
				'* LIST (\\HasNoChildren \\Sent) "/" Sent\r\n' +
				'* LIST (\\HasNoChildren \\Trash) "/" Trash\r\n' +
				'a OK LIST completed\r\n',
		);

		const select = await s.send('b SELECT INBOX\r\n');
		expect(select).toContain('* 2 EXISTS\r\n');
		expect(select).toContain('* 0 RECENT\r\n');
		expect(select).toMatch(/\* OK \[UIDVALIDITY \d+\] /);
		expect(select).toContain('* OK [UIDNEXT 3] ');
		expect(select).toContain(
			'* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n',
		);
		expect(select).toEndWith('b OK [READ-WRITE] SELECT completed\r\n');

		const fetch = await s.send(
			'c FETCH 1:* (FLAGS ENVELOPE BODYSTRUCTURE)\r\n',
		);
		expect(fetch).toStartWith(
			'* 1 FETCH (FLAGS () ENVELOPE ("Mon, 7 Feb 1994 21:52:25 -0800" "afternoon meeting"',
		);
		expect(fetch).toContain('* 2 FETCH (FLAGS (\\Flagged) ENVELOPE (');
		expect(fetch).toContain(
			'("application" "pdf" ("name" "report.pdf") NIL NIL "BASE64" 12 NIL ("attachment"',
		);
		expect(fetch).toEndWith('c OK FETCH completed\r\n');

		const body = await s.send('d UID FETCH 1 BODY.PEEK[]\r\n');
		const size = new TextEncoder().encode(SIMPLE).length;
		expect(body).toBe(
			`* 1 FETCH (UID 1 BODY[] {${size}}\r\n${SIMPLE})\r\nd OK UID FETCH completed\r\n`,
		);
		expect(await s.send('e FETCH 1 FLAGS\r\n')).toBe(
			'* 1 FETCH (FLAGS ())\r\ne OK FETCH completed\r\n',
		);

		expect(await s.send('f STORE 1 +FLAGS (\\Seen)\r\n')).toBe(
			'* 1 FETCH (FLAGS (\\Seen))\r\nf OK STORE completed\r\n',
		);

		expect(await s.send('g MOVE 1 Archive\r\n')).toBe(
			'* 1 EXPUNGE\r\ng OK MOVE completed\r\n',
		);
		expect(await s.send('h STATUS Archive (MESSAGES UNSEEN)\r\n')).toBe(
			'* STATUS Archive (MESSAGES 1 UNSEEN 0)\r\nh OK STATUS completed\r\n',
		);

		await s.send('i STORE 1 +FLAGS.SILENT (\\Deleted)\r\n');
		expect(await s.send('j EXPUNGE\r\n')).toBe(
			'* 1 EXPUNGE\r\nj OK EXPUNGE completed\r\n',
		);

		expect(await s.send('k IDLE\r\n')).toBe('+ idling\r\n');
		await store.addMessage(accountId, inbox.id, {
			content: new TextEncoder().encode(SIMPLE),
		});
		expect(await s.until((out) => out.includes('EXISTS'))).toBe(
			'* 1 EXISTS\r\n',
		);
		expect(await s.send('DONE\r\n')).toBe('k OK IDLE terminated\r\n');
		expect(await s.send('l UID SEARCH ALL\r\n')).toBe(
			'* SEARCH 3\r\nl OK UID SEARCH completed\r\n',
		);
	});

	test('IDLE wakes on server.notify too, and a message flagged elsewhere is told', async () => {
		const { store, accountId, inbox } = await seededStore();
		const s = await loggedIn(
			imapOptions(store, accountId, { idleInterval: 3600 }),
		);
		await s.send('a SELECT INBOX\r\n');
		await s.send('b IDLE\r\n');
		const [first] = (await store.listMessages(accountId, inbox.id)).map(
			(entry) => entry.message,
		);
		await store.setFlags(accountId, [first?.id as string], {
			add: ['\\Answered'],
		});
		s.connection.wake?.();
		expect(await s.until((out) => out.includes('FETCH'))).toBe(
			'* 1 FETCH (UID 1 FLAGS (\\Answered))\r\n',
		);
		expect(await s.send('done\r\n')).toBe('b OK IDLE terminated\r\n');
	});

	test('a message expunged by another session is told at the next NOOP', async () => {
		const { store, accountId, inbox } = await seededStore();
		const s = await loggedIn(imapOptions(store, accountId));
		await s.send('a SELECT INBOX\r\n');
		const [first] = (await store.listMessages(accountId, inbox.id)).map(
			(entry) => entry.message,
		);
		await store.destroyMessages(accountId, [first?.id as string]);
		expect(await s.send('b NOOP\r\n')).toBe(
			'* 1 EXPUNGE\r\nb OK NOOP completed\r\n',
		);
		expect(await s.send('c FETCH 1 UID\r\n')).toBe(
			'* 1 FETCH (UID 2)\r\nc OK FETCH completed\r\n',
		);
	});

	test('the selected mailbox deleted elsewhere: BYE', async () => {
		const { store, accountId, archive } = await seededStore();
		const s = await loggedIn(imapOptions(store, accountId));
		await s.send('a SELECT Archive\r\n');
		await store.deleteMailbox(accountId, archive.id);
		expect(await s.send('b NOOP\r\n')).toStartWith('* BYE ');
		expect(s.ended).toBe(true);
	});
});
