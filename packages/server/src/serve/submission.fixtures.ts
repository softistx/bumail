import { LineClient } from './line-client.fixtures';
import { PASSWORD } from './serve.fixtures';

/** `AUTH PLAIN` for `user` (RFC 4616): no authorization identity. */
export function plain(user: string, password = PASSWORD): string {
	return `AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString('base64')}`;
}

/**
 * A session on a submission port, encrypted — from the first byte on
 * `submissions`, by STARTTLS otherwise — after EHLO; logged in as `user`
 * when given, asserting the 235.
 */
export async function session(
	port: number,
	implicit: boolean,
	user?: string,
): Promise<LineClient> {
	const client = await LineClient.connect(port, implicit);
	await client.reply();
	await client.smtp('EHLO client.example');
	if (!implicit) {
		await client.smtp('STARTTLS');
		await client.startTls();
		await client.smtp('EHLO client.example');
	}
	if (user !== undefined) {
		const answer = await client.smtp(plain(user));
		if (!answer.startsWith('235 ')) {
			throw new Error(`the login of ${user} failed: ${answer}`);
		}
	}
	return client;
}

/** MAIL, RCPT each, DATA and the message: every reply, the last the one to the message. */
export async function submit(
	client: LineClient,
	from: string,
	to: readonly string[],
	text: string,
): Promise<{ replies: string[]; last: string }> {
	const replies = [await client.smtp(`MAIL FROM:<${from}>`)];
	let accepted = 0;
	for (const rcpt of to) {
		const answer = await client.smtp(`RCPT TO:<${rcpt}>`);
		replies.push(answer);
		if (answer.startsWith('250')) accepted++;
	}
	if (accepted === 0 || !replies[0]?.startsWith('250')) {
		return { replies, last: replies.at(-1) ?? '' };
	}
	replies.push(await client.smtp('DATA'));
	const body = text.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
	const last = await client.smtp(`${body}\r\n.`);
	replies.push(last);
	return { replies, last };
}

/** A message from `from` to `to`, as a mail client writes it. */
export function letter(from: string, to: string, subject: string): string {
	return [
		`From: Someone <${from}>`,
		`To: <${to}>`,
		`Subject: ${subject}`,
		`Message-ID: <${crypto.randomUUID()}@client.example>`,
		`Date: ${new Date().toUTCString()}`,
		'',
		'Hello there.',
		'',
	].join('\r\n');
}

/** Waits until `lines` has one matching `pattern`, for at most `ms`; answers it. */
export async function logged(
	lines: readonly string[],
	pattern: RegExp,
	ms = 10_000,
): Promise<string> {
	const end = Date.now() + ms;
	for (;;) {
		const line = lines.find((l) => pattern.test(l));
		if (line !== undefined) return line;
		if (Date.now() > end) {
			throw new Error(`no log line matched ${pattern}:\n${lines.join('\n')}`);
		}
		await Bun.sleep(20);
	}
}
