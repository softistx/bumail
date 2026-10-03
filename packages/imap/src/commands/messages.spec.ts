import { describe, expect, test } from 'bun:test';
import {
	imapOptions,
	loggedIn,
	MULTIPART,
	seededStore,
} from '../server/session.fixtures';

async function selected(rev2 = false) {
	const { store, accountId, inbox } = await seededStore();
	const s = await loggedIn(imapOptions(store, accountId), { rev2 });
	await s.send('s SELECT INBOX\r\n');
	return { s, store, accountId, inbox };
}

describe('FETCH (RFC 9051 §6.4.5)', () => {
	test('FAST, RFC822.SIZE, INTERNALDATE, UID', async () => {
		const { s } = await selected();
		expect(await s.send('a FETCH 1 (UID INTERNALDATE)\r\n')).toBe(
			'* 1 FETCH (UID 1 INTERNALDATE "08-Feb-1994 05:52:25 +0000")\r\na OK FETCH completed\r\n',
		);
		expect(await s.send('b FETCH 2 FAST\r\n')).toMatch(
			/^\* 2 FETCH \(FLAGS \(\\Flagged\) INTERNALDATE "02-Feb-2027 10:00:05 \+0000" RFC822.SIZE \d+\)\r\n/,
		);
	});

	test('a partial body, and BODY[] sets \\Seen with FLAGS in the answer', async () => {
		const { s } = await selected();
		expect(await s.send('a FETCH 1 (BODY[]<0.4>)\r\n')).toBe(
			'* 1 FETCH (BODY[]<0> {4}\r\nDate FLAGS (\\Seen))\r\na OK FETCH completed\r\n',
		);
		expect(await s.send('b FETCH 1 BODY.PEEK[]<100000.5>\r\n')).toBe(
			'* 1 FETCH (BODY[]<100000> {0}\r\n)\r\nb OK FETCH completed\r\n',
		);
	});

	test('sections of a multipart: a part, its MIME header, header fields; a missing one is NIL', async () => {
		const { s } = await selected();
		const out = await s.send(
			'a FETCH 2 (BODY.PEEK[1] BODY.PEEK[2.MIME] BODY.PEEK[HEADER.FIELDS (SUBJECT)] BODY.PEEK[9])\r\n',
		);
		expect(out).toContain('BODY[1] {29}\r\n');
		expect(out).toContain('BODY[2.MIME] {');
		expect(out).toContain(
			'BODY[HEADER.FIELDS (SUBJECT)] {28}\r\nSubject: Report attached\r\n\r\n',
		);
		expect(out).toContain('BODY[9] NIL)');
	});

	test('the IMAP4rev1 names: RFC822.HEADER, BODY', async () => {
		const { s } = await selected();
		expect(await s.send('a FETCH 1 RFC822.HEADER\r\n')).toStartWith(
			'* 1 FETCH (RFC822.HEADER {',
		);
		expect(await s.send('b FETCH 1 BODY\r\n')).toBe(
			'* 1 FETCH (BODY ("text" "plain" ("charset" "US-ASCII") NIL NIL "7BIT" 55 1))\r\nb OK FETCH completed\r\n',
		);
	});

	test('what is not supported yet is BAD, by name', async () => {
		const { s } = await selected();
		expect(await s.send('a FETCH 1 BINARY[1]\r\n')).toBe(
			'a BAD BINARY is not supported yet\r\n',
		);
		expect(await s.send('b FETCH 1 FLAGS (CHANGEDSINCE 1)\r\n')).toBe(
			'b BAD FETCH modifiers are not supported\r\n',
		);
		expect(await s.send('c FETCH 1 (BODY[4.TEXTX])\r\n')).toBe(
			'c BAD Unknown section TEXTX\r\n',
		);
	});

	test('a message the store lost between SELECT and FETCH is skipped, not a crash', async () => {
		const { s, store, accountId, inbox } = await selected();
		const [first] = await store.listMessages(accountId, inbox.id);
		await store.destroyMessages(accountId, [first?.message.id as string]);
		expect(await s.send('a FETCH 1:2 UID\r\n')).toEndWith(
			'a OK FETCH completed\r\n',
		);
	});
});

describe('STORE (RFC 9051 §6.4.6)', () => {
	test('FLAGS replace, -FLAGS remove, a keyword is kept as it was set; UID STORE says the UID', async () => {
		const { s } = await selected();
		expect(await s.send('a STORE 2 FLAGS ($Important \\Seen)\r\n')).toBe(
			'* 2 FETCH (FLAGS ($Important \\Seen))\r\na OK STORE completed\r\n',
		);
		expect(await s.send('b UID STORE 2 -FLAGS \\Seen\r\n')).toBe(
			'* 2 FETCH (FLAGS ($Important) UID 2)\r\nb OK UID STORE completed\r\n',
		);
		expect(await s.send('c STORE 1 +FLAGS (\\Recent)\r\n')).toBe(
			'c NO [CANNOT] "\\Recent" is not a flag a store keeps\r\n',
		);
		expect(
			await s.send('d STORE 1 (UNCHANGEDSINCE 3) +FLAGS (\\Seen)\r\n'),
		).toBe('d BAD STORE modifiers are not supported\r\n');
	});
});

describe('SEARCH (RFC 9051 §6.4.4)', () => {
	test('flags, headers, sizes and dates; ESEARCH in IMAP4rev2', async () => {
		const { s } = await selected();
		expect(await s.send('a SEARCH FLAGGED\r\n')).toBe(
			'* SEARCH 2\r\na OK SEARCH completed\r\n',
		);
		expect(await s.send('b SEARCH UNSEEN NOT FLAGGED\r\n')).toBe(
			'* SEARCH 1\r\nb OK SEARCH completed\r\n',
		);
		expect(await s.send('c SEARCH OR SUBJECT meeting FROM rene\r\n')).toBe(
			'* SEARCH 1 2\r\nc OK SEARCH completed\r\n',
		);
		expect(await s.send('d SEARCH SENTBEFORE 1-Jan-2000\r\n')).toBe(
			'* SEARCH 1\r\nd OK SEARCH completed\r\n',
		);
		expect(await s.send('e SEARCH SINCE 1-Jan-2027 LARGER 10\r\n')).toBe(
			'* SEARCH 2\r\ne OK SEARCH completed\r\n',
		);
		expect(await s.send('f UID SEARCH UID 2:*\r\n')).toBe(
			'* SEARCH 2\r\nf OK UID SEARCH completed\r\n',
		);
	});

	test('IMAP4rev2: ESEARCH, and RETURN', async () => {
		const { s } = await selected(true);
		expect(await s.send('h SEARCH ALL\r\n')).toBe(
			'* ESEARCH (TAG "h") ALL 1:2\r\nh OK SEARCH completed\r\n',
		);
		expect(await s.send('i UID SEARCH RETURN (MIN MAX COUNT) ALL\r\n')).toBe(
			'* ESEARCH (TAG "i") UID MIN 1 MAX 2 COUNT 2\r\ni OK UID SEARCH completed\r\n',
		);
		expect(await s.send('j SEARCH RETURN () DELETED\r\n')).toBe(
			'* ESEARCH (TAG "j")\r\nj OK SEARCH completed\r\n',
		);
	});

	test('TEXT and BODY read the stored bytes, without case; a needle across chunks is found', async () => {
		const { s, store, accountId, inbox } = await selected();
		const filler = 'x'.repeat(70_000);
		await store.addMessage(accountId, inbox.id, {
			content: new TextEncoder().encode(
				`Subject: big\r\n\r\n${filler}NeEdLe\r\n`,
			),
		});
		await s.send('n NOOP\r\n');
		expect(await s.send('a SEARCH BODY needle\r\n')).toBe(
			'* SEARCH 3\r\na OK SEARCH completed\r\n',
		);
		expect(await s.send('b SEARCH TEXT report.pdf\r\n')).toBe(
			'* SEARCH 2\r\nb OK SEARCH completed\r\n',
		);
		expect(await s.send('c SEARCH HEADER Message-ID B27397\r\n')).toBe(
			'* SEARCH 1\r\nc OK SEARCH completed\r\n',
		);
	});

	test('a charset other than UTF-8: BADCHARSET; SAVE: refused', async () => {
		const { s } = await selected();
		expect(await s.send('a SEARCH CHARSET UTF-8 ALL\r\n')).toBe(
			'* SEARCH 1 2\r\na OK SEARCH completed\r\n',
		);
		expect(await s.send('b SEARCH CHARSET KOI8-R ALL\r\n')).toBe(
			'b NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported charset\r\n',
		);
		expect(await s.send('c SEARCH RETURN (SAVE) ALL\r\n')).toStartWith(
			'c BAD ',
		);
		expect(await s.send('d SEARCH FROBNICATE\r\n')).toStartWith('d BAD ');
	});
});

describe('APPEND (RFC 9051 §6.3.12)', () => {
	test('a message streamed in with flags and a date, then seen by the selected session', async () => {
		const { s } = await selected();
		const message = 'Subject: appended\r\n\r\nhello\r\n';
		expect(
			await s.send(
				`a APPEND INBOX (\\Seen) "05-Mar-2027 09:00:00 +0100" {${message.length}}\r\n`,
			),
		).toBe('+ Ready for literal data\r\n');
		expect(await s.send(`${message}\r\n`)).toBe(
			'* 3 EXISTS\r\na OK APPEND completed\r\n',
		);
		expect(
			await s.send(
				'b FETCH 3 (FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT)])\r\n',
			),
		).toContain('FLAGS (\\Seen) INTERNALDATE "05-Mar-2027 08:00:00 +0000"');
	});

	test('LITERAL+, a message of 1 MiB in many chunks', async () => {
		const { s } = await selected();
		const message = `Subject: big\r\n\r\n${'y'.repeat(1 << 20)}`;
		const bytes = new TextEncoder().encode(
			`a APPEND Sent {${message.length}+}\r\n${message}\r\n`,
		);
		for (let at = 0; at < bytes.length; at += 4096)
			s.connection.receive(bytes.subarray(at, at + 4096));
		await s.connection.idle();
		expect(s.take()).toBe('a OK APPEND completed\r\n');
		expect(await s.send('b STATUS Sent (MESSAGES SIZE)\r\n')).toStartWith(
			`* STATUS Sent (MESSAGES 1 SIZE ${message.length})`,
		);
	});

	test('refused: no such mailbox, a bad flag, text after the message, a second message', async () => {
		const { s } = await selected();
		expect(await s.send('a APPEND Nowhere {1}\r\n')).toBe(
			'a NO [TRYCREATE] No such mailbox\r\n',
		);
		expect(await s.send('b APPEND INBOX (\\Recent) {1}\r\n')).toBe(
			'b BAD Invalid flag\r\n',
		);
		expect(await s.send('c APPEND INBOX {1+}\r\nx extra\r\n')).toBe(
			'c BAD Unexpected text after the message\r\n',
		);
		expect(await s.send('d NOOP\r\n')).toBe('d OK NOOP completed\r\n');
		// A second non-synchronising message would follow at once: there is no way but to close.
		expect(
			await s.send(
				`e APPEND INBOX {${MULTIPART.length}+}\r\n${MULTIPART} {1+}\r\nx\r\n`,
			),
		).toBe('* BYE MULTIAPPEND is not supported, closing\r\n');
	});
});
