import { describe, expect, test } from 'bun:test';
import {
	fakeSession,
	imapOptions,
	loggedIn,
	seededStore,
} from './session.fixtures';

async function setup(overrides: Parameters<typeof imapOptions>[2] = {}) {
	const { store, accountId } = await seededStore();
	return imapOptions(store, accountId, overrides);
}

describe('hostile input is refused, never crashes and never grows memory', () => {
	test('a 1 GB synchronising literal: BAD [TOOBIG], no continuation, the session goes on', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('a LOGIN alice {1073741824}\r\n')).toBe(
			'a BAD [TOOBIG] Literal over 65536 bytes\r\n',
		);
		expect(await s.send('b NOOP\r\n')).toBe('b OK NOOP completed\r\n');
	});

	test('a 1 GB non-synchronising literal: BYE, since its bytes would follow', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('a LOGIN alice {1073741824+}\r\n')).toBe(
			'* BYE [TOOBIG] Literal over 65536 bytes, closing\r\n',
		);
		expect(s.ended).toBe(true);
	});

	test('a 1 GB APPEND: NO [TOOBIG] before a byte is read', async () => {
		const s = await loggedIn(await setup());
		expect(await s.send('a APPEND INBOX {1073741824}\r\n')).toBe(
			'a NO [TOOBIG] The message is over 26214400 bytes\r\n',
		);
	});

	test('a literal of more than 10 digits is not a literal', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('a LOGIN alice {99999999999}\r\n')).toStartWith(
			'a BAD ',
		);
	});

	test('a million-element sequence set is answered from ranges', async () => {
		const s = await loggedIn(await setup());
		await s.send('a SELECT INBOX\r\n');
		const set = Array.from(
			{ length: 6000 },
			(_, i) => `${i * 2 + 1}:${i * 2 + 2}`,
		).join(',');
		const started = performance.now();
		expect(await s.send(`b UID FETCH ${set} UID\r\n`)).toEndWith(
			'b OK UID FETCH completed\r\n',
		);
		expect(await s.send('c UID FETCH 1:4294967295 UID\r\n')).toBe(
			'* 1 FETCH (UID 1)\r\n* 2 FETCH (UID 2)\r\nc OK UID FETCH completed\r\n',
		);
		expect(await s.send('d SEARCH 1:4294967295,1:1000000\r\n')).toBe(
			'* SEARCH 1 2\r\nd OK SEARCH completed\r\n',
		);
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test('a sequence number past the last message is BAD (RFC 9051 §6.4.4)', async () => {
		const s = await loggedIn(await setup());
		await s.send('a SELECT INBOX\r\n');
		expect(await s.send('b FETCH 3 FLAGS\r\n')).toBe(
			'b BAD No such message\r\n',
		);
		expect(await s.send('c FETCH 0 FLAGS\r\n')).toBe(
			'c BAD Expected a sequence set\r\n',
		);
	});

	test('30 000 open parentheses: BAD, at depth 32', async () => {
		const s = await loggedIn(await setup());
		await s.send('a SELECT INBOX\r\n');
		expect(await s.send(`b SEARCH ${'('.repeat(30_000)}ALL\r\n`)).toBe(
			'b BAD Search keys nest too deep\r\n',
		);
		expect(
			await s.send(`c STATUS INBOX ${'('.repeat(30_000)}\r\n`),
		).toStartWith('c BAD ');
		expect(await s.send(`d SEARCH ${'NOT '.repeat(10_000)}ALL\r\n`)).toBe(
			'd BAD Search keys nest too deep\r\n',
		);
	});

	test('more than 32 literals in one command', async () => {
		const s = await fakeSession(await setup());
		const literals = '{1+}\r\nx '.repeat(40);
		expect(await s.send(`a LOGIN ${literals}\r\n`)).toStartWith(
			'* BYE More than 32 literals in one command',
		);
		expect(s.ended).toBe(true);
	});

	test('a line over 64 KiB: BAD, the session goes on', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send(`a NOOP ${'x'.repeat(100_000)}\r\nb NOOP\r\n`)).toBe(
			'a BAD Command line too long\r\nb OK NOOP completed\r\n',
		);
	});

	test('a client that never reads: the server stops at a bounded backlog', async () => {
		const s = await loggedIn(await setup());
		await s.send('a SELECT INBOX\r\n');
		s.stall();
		const commands = 'b FETCH 1:* (BODY.PEEK[])\r\n'.repeat(2000);
		s.connection.receive(new TextEncoder().encode(commands));
		await Bun.sleep(100);
		expect(s.backlog).toBeLessThan(256 * 1024);
	});

	test('a quoted string with a bare CR or an unknown escape is BAD', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('a LOGIN "ali\rce" x\r\n')).toStartWith('a BAD ');
		expect(await s.send('b LOGIN "ali\\ce" x\r\n')).toStartWith('b BAD ');
	});

	test('8-bit bytes and NUL in a command are BAD, not a crash', async () => {
		const s = await fakeSession(await setup());
		s.connection.receive(
			new Uint8Array([
				0x61, 0x20, 0x4e, 0x4f, 0x4f, 0x50, 0x00, 0xff, 0x0d, 0x0a,
			]),
		);
		await s.connection.idle();
		expect(s.take()).toStartWith('a BAD ');
	});
});
