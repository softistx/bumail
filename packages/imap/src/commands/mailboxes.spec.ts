import { describe, expect, test } from 'bun:test';
import { imapOptions, loggedIn, seededStore } from '../server/session.fixtures';

async function session(rev2 = false) {
	const { store, accountId } = await seededStore();
	return loggedIn(imapOptions(store, accountId), { rev2 });
}

describe('CREATE, DELETE, RENAME (RFC 9051 §6.3.4–6.3.6)', () => {
	test('CREATE makes the missing parents; a trailing delimiter is dropped', async () => {
		const s = await session();
		expect(await s.send('A003 CREATE owatagusiam/\r\n')).toBe(
			'A003 OK CREATE completed\r\n',
		);
		expect(await s.send('A004 CREATE owatagusiam/blurdybloop\r\n')).toBe(
			'A004 OK CREATE completed\r\n',
		);
		expect(await s.send('a CREATE x/y/z\r\n')).toBe(
			'a OK CREATE completed\r\n',
		);
		expect(await s.send('b LIST "" x*\r\n')).toBe(
			'* LIST (\\HasChildren) "/" x\r\n* LIST (\\HasChildren) "/" x/y\r\n* LIST (\\HasNoChildren) "/" x/y/z\r\nb OK LIST completed\r\n',
		);
		expect(await s.send('c CREATE inbox\r\n')).toBe(
			'c NO [ALREADYEXISTS] The mailbox already exists\r\n',
		);
		expect(await s.send('d CREATE a//b\r\n')).toStartWith('d BAD ');
	});

	test('DELETE: not INBOX, not a parent, not the selected mailbox', async () => {
		const s = await session();
		await s.send('a CREATE foo/bar\r\n');
		expect(await s.send('b DELETE INBOX\r\n')).toBe(
			'b NO [CANNOT] INBOX cannot be deleted\r\n',
		);
		expect(await s.send('c DELETE foo\r\n')).toBe(
			'c NO [CANNOT] Delete the mailboxes inside it first\r\n',
		);
		expect(await s.send('d DELETE foo/bar\r\n')).toBe(
			'd OK DELETE completed\r\n',
		);
		expect(await s.send('e DELETE nothere\r\n')).toBe(
			'e NO [NONEXISTENT] No such mailbox\r\n',
		);
		await s.send('f SELECT Archive\r\n');
		expect(await s.send('g DELETE Archive\r\n')).toBe(
			'g NO [INUSE] The mailbox is selected: close it first\r\n',
		);
	});

	test('RENAME moves the children with it', async () => {
		const s = await session();
		await s.send('a CREATE foo/bar\r\n');
		expect(await s.send('b RENAME foo zap\r\n')).toBe(
			'b OK RENAME completed\r\n',
		);
		expect(await s.send('c LIST "" zap*\r\n')).toBe(
			'* LIST (\\HasChildren) "/" zap\r\n* LIST (\\HasNoChildren) "/" zap/bar\r\nc OK LIST completed\r\n',
		);
		expect(await s.send('d RENAME INBOX old\r\n')).toBe(
			'd NO [CANNOT] Renaming INBOX is not supported\r\n',
		);
		expect(await s.send('e RENAME zap Sent\r\n')).toBe(
			'e NO [ALREADYEXISTS] The new name is taken\r\n',
		);
		expect(await s.send('f RENAME zap zap/bar/in\r\n')).toBe(
			'f NO [CANNOT] A mailbox cannot move inside itself\r\n',
		);
	});

	test('names that are not ASCII: modified UTF-7 in IMAP4rev1, UTF-8 in IMAP4rev2', async () => {
		const s = await session();
		expect(await s.send('a CREATE "~peter/mail/&U,BTFw-/&ZeVnLIqe-"\r\n')).toBe(
			'a OK CREATE completed\r\n',
		);
		expect(await s.send('b LIST "" "~peter/mail/*/*"\r\n')).toBe(
			'* LIST (\\HasNoChildren) "/" ~peter/mail/&U,BTFw-/&ZeVnLIqe-\r\nb OK LIST completed\r\n',
		);
		expect(await s.send('c CREATE "&Jjo!"\r\n')).toStartWith('c BAD ');
		await s.send('d ENABLE IMAP4rev2\r\n');
		expect(await s.send('e LIST "" "~peter/mail/*/*"\r\n')).toBe(
			'* LIST (\\HasNoChildren) "/" {28}\r\n~peter/mail/台北/日本語\r\ne OK LIST completed\r\n',
		);
	});
});

describe('LIST (RFC 9051 §6.3.9, RFC 5258, RFC 6154)', () => {
	test('the hierarchy delimiter, and % that stops at it', async () => {
		const s = await session();
		await s.send('a CREATE Work/2026\r\n');
		expect(await s.send('b LIST "" ""\r\n')).toBe(
			'* LIST (\\Noselect) "/" ""\r\nb OK LIST completed\r\n',
		);
		expect(await s.send('c LIST "" %\r\n')).toContain(
			'* LIST (\\HasChildren) "/" Work\r\n',
		);
		expect(await s.send('d LIST "" %\r\n')).not.toContain('Work/2026');
		expect(await s.send('e LIST Work/ %\r\n')).toBe(
			'* LIST (\\HasNoChildren) "/" Work/2026\r\ne OK LIST completed\r\n',
		);
	});

	test('SPECIAL-USE selection and RETURN; SUBSCRIBED; STATUS returned', async () => {
		const s = await session();
		expect(await s.send('a LIST (SPECIAL-USE) "" *\r\n')).toBe(
			'* LIST (\\HasNoChildren \\Archive) "/" Archive\r\n* LIST (\\HasNoChildren \\Sent) "/" Sent\r\n* LIST (\\HasNoChildren \\Trash) "/" Trash\r\na OK LIST completed\r\n',
		);
		expect(await s.send('b LIST (SUBSCRIBED) "" *\r\n')).not.toContain('Trash');
		expect(
			await s.send('c LIST "" INBOX RETURN (STATUS (MESSAGES UIDNEXT))\r\n'),
		).toBe(
			'* LIST (\\HasNoChildren) "/" INBOX\r\n* STATUS INBOX (MESSAGES 2 UIDNEXT 3)\r\nc OK LIST completed\r\n',
		);
		expect(await s.send('d LIST "" (INBOX Sent) RETURN (SUBSCRIBED)\r\n')).toBe(
			'* LIST (\\HasNoChildren \\Subscribed) "/" INBOX\r\n* LIST (\\HasNoChildren \\Sent \\Subscribed) "/" Sent\r\nd OK LIST completed\r\n',
		);
	});

	test('SUBSCRIBE, UNSUBSCRIBE and LSUB (IMAP4rev1)', async () => {
		const s = await session();
		expect(await s.send('a SUBSCRIBE Trash\r\n')).toBe(
			'a OK SUBSCRIBE completed\r\n',
		);
		expect(await s.send('b LSUB "" T*\r\n')).toBe(
			'* LSUB (\\HasNoChildren \\Trash) "/" Trash\r\nb OK LSUB completed\r\n',
		);
		expect(await s.send('c UNSUBSCRIBE Trash\r\n')).toBe(
			'c OK UNSUBSCRIBE completed\r\n',
		);
		expect(await s.send('d LSUB "" T*\r\n')).toBe('d OK LSUB completed\r\n');
		expect(await s.send('e SUBSCRIBE Nowhere\r\n')).toBe(
			'e NO [NONEXISTENT] No such mailbox\r\n',
		);
	});

	test('a pattern of stars is matched without backtracking', async () => {
		const s = await session();
		const started = performance.now();
		expect(await s.send(`a LIST "" "${'*a'.repeat(400)}b"\r\n`)).toBe(
			'a OK LIST completed\r\n',
		);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe('SELECT, EXAMINE, STATUS (RFC 9051 §6.3.2, 6.3.3, 6.3.11)', () => {
	test('EXAMINE is read-only: STORE, EXPUNGE and MOVE are refused, FETCH sets no \\Seen', async () => {
		const s = await session();
		expect(await s.send('a EXAMINE INBOX\r\n')).toContain(
			'* OK [PERMANENTFLAGS ()] ',
		);
		expect(await s.send('b STORE 1 +FLAGS (\\Seen)\r\n')).toBe(
			'b NO [READ-ONLY] The mailbox is read-only\r\n',
		);
		expect(await s.send('c EXPUNGE\r\n')).toBe(
			'c NO [READ-ONLY] The mailbox is read-only\r\n',
		);
		expect(await s.send('d FETCH 1 (BODY[TEXT])\r\n')).not.toContain('FLAGS');
	});

	test('IMAP4rev2: the LIST line, no RECENT, OK [CLOSED] when another is selected', async () => {
		const s = await session(true);
		const select = await s.send('a SELECT INBOX\r\n');
		expect(select).toContain('* LIST () "/" INBOX\r\n');
		expect(select).not.toContain('RECENT');
		expect(await s.send('b EXAMINE Sent\r\n')).toStartWith(
			'* OK [CLOSED] Previous mailbox is now closed\r\n',
		);
		// A SELECT that fails leaves no mailbox selected (§6.3.2).
		expect(await s.send('c SELECT Nothere\r\n')).toBe(
			'* OK [CLOSED] Previous mailbox is now closed\r\nc NO [NONEXISTENT] No such mailbox\r\n',
		);
		expect(await s.send('d FETCH 1 FLAGS\r\n')).toBe(
			'd BAD FETCH is not valid in the authenticated state\r\n',
		);
	});

	test('CLOSE expunges silently; UNSELECT does not', async () => {
		const s = await session();
		await s.send('a SELECT INBOX\r\n');
		await s.send('b STORE 1 +FLAGS.SILENT (\\Deleted)\r\n');
		expect(await s.send('c UNSELECT\r\n')).toBe('c OK UNSELECT completed\r\n');
		await s.send('d SELECT INBOX\r\n');
		expect(await s.send('e CLOSE\r\n')).toBe('e OK CLOSE completed\r\n');
		expect(await s.send('f STATUS INBOX (MESSAGES DELETED SIZE)\r\n')).toMatch(
			/^\* STATUS INBOX \(MESSAGES 1 DELETED 0 SIZE \d+\)\r\n/,
		);
	});

	test('UID EXPUNGE takes only the UIDs named (RFC 4315 §2.1)', async () => {
		const s = await session();
		await s.send('a SELECT INBOX\r\n');
		await s.send('b STORE 1:2 +FLAGS.SILENT (\\Deleted)\r\n');
		expect(await s.send('c UID EXPUNGE 2\r\n')).toBe(
			'* 2 EXPUNGE\r\nc OK UID EXPUNGE completed\r\n',
		);
	});

	test('COPY to a mailbox that does not exist: TRYCREATE; MOVE to the same: CANNOT', async () => {
		const s = await session();
		await s.send('a SELECT INBOX\r\n');
		expect(await s.send('b COPY 1 Nowhere\r\n')).toBe(
			'b NO [TRYCREATE] No such mailbox\r\n',
		);
		expect(await s.send('c MOVE 1 INBOX\r\n')).toBe(
			'c NO [CANNOT] The messages are already in this mailbox\r\n',
		);
		expect(await s.send('d UID COPY 1:2 Sent\r\n')).toBe(
			'd OK UID COPY completed\r\n',
		);
		expect(await s.send('e STATUS Sent (MESSAGES)\r\n')).toStartWith(
			'* STATUS Sent (MESSAGES 2)',
		);
	});
});
