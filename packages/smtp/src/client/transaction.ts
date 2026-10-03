import { type RecipientReply, SmtpError } from '../errors';
import { DataWriter } from '../protocol/data-writer';
import type { Reply } from '../protocol/reply';
import { bareLineBreak, type Content } from './content';
import { refused, shown } from './refusal';
import type { Ready } from './session';
import type { ClientSettings } from './settings';
import type { ClientSocket } from './socket';

/** What the server said to the envelope and the message. */
export interface Delivered {
	readonly accepted: readonly RecipientReply[];
	readonly rejected: readonly RecipientReply[];
	readonly reply: Reply;
}

const missing = (host: string, extension: string, why: string) =>
	new SmtpError(
		'EXTENSION_MISSING',
		`${host} does not offer ${extension}, which ${why}`,
	);

/** MAIL FROM's parameters: SIZE (RFC 1870), BODY (RFC 6152), SMTPUTF8 (RFC 6531). */
function mailParameters(
	host: string,
	settings: ClientSettings,
	content: Content,
	extensions: ReadonlyMap<string, string>,
): string {
	let parameters = '';
	const size = extensions.get('SIZE');
	if (size !== undefined && content.size !== undefined) {
		const max = Number(size);
		if (Number.isSafeInteger(max) && max > 0 && content.size > max) {
			throw new SmtpError(
				'MESSAGE_TOO_BIG',
				`The message (${content.size} bytes) is larger than the ${max} bytes ${host} takes (SIZE)`,
				{ temporary: false },
			);
		}
		parameters += ` SIZE=${content.size}`;
	}
	if (extensions.has('8BITMIME')) parameters += ' BODY=8BITMIME';
	else if (content.eightBit) {
		throw missing(host, '8BITMIME', 'the message needs: it has 8-bit bytes');
	}
	if (settings.smtputf8) {
		if (!extensions.has('SMTPUTF8')) {
			throw missing(
				host,
				'SMTPUTF8',
				'an address that is not ASCII needs (or smtputf8 asked for)',
			);
		}
		parameters += ' SMTPUTF8';
	}
	return parameters;
}

/** MAIL FROM and every RCPT TO: in one write with PIPELINING (RFC 2920), else one by one. */
async function envelope(
	socket: ClientSocket,
	settings: ClientSettings,
	content: Content,
	ready: Ready,
): Promise<{ accepted: RecipientReply[]; rejected: RecipientReply[] }> {
	const { host } = socket;
	const { timeouts } = settings;
	const mail = `MAIL FROM:<${settings.from}>${mailParameters(host, settings, content, ready.extensions)}\r\n`;
	const rcpts = settings.to.map((to) => `RCPT TO:<${to}>\r\n`);
	const pipelining = ready.extensions.has('PIPELINING');
	socket.write(pipelining ? mail + rcpts.join('') : mail);
	const from = await socket.reply('the reply to MAIL FROM', timeouts.mail);
	if (from.code !== 250) throw refused(host, 'the sender', from);
	const accepted: RecipientReply[] = [];
	const rejected: RecipientReply[] = [];
	for (const [i, recipient] of settings.to.entries()) {
		if (!pipelining) socket.write(rcpts[i] as string);
		const reply = await socket.reply('the reply to RCPT TO', timeouts.rcpt);
		const into = reply.code === 250 || reply.code === 251 ? accepted : rejected;
		into.push({ recipient, reply });
	}
	if (accepted.length === 0) {
		const first = rejected[0] as RecipientReply;
		throw new SmtpError(
			'RECIPIENTS_REFUSED',
			`${host} refused every recipient, ${first.recipient} with ${shown(first.reply)}`,
			{
				reply: first.reply,
				rejected,
				temporary: rejected.some(({ reply }) => reply.code < 500),
			},
		);
	}
	return { accepted, rejected };
}

/** The message, stuffed, block by block as the server takes it; a bad stream hangs up before the dot. */
async function data(
	socket: ClientSocket,
	settings: ClientSettings,
	content: Content,
	ready: Ready,
): Promise<Reply> {
	const { host } = socket;
	const { timeouts } = settings;
	socket.write('DATA\r\n');
	const start = await socket.reply('the reply to DATA', timeouts.dataStart);
	if (start.code !== 354) throw refused(host, 'DATA', start);
	const writer = new DataWriter(settings.normalizeLineEnds);
	const eightBitOk = ready.extensions.has('8BITMIME');
	const chunks = content.chunks();
	try {
		for (;;) {
			// The caller's stream is bounded as the server is: a stalled one times out.
			const chunk = await socket.within(
				chunks.next(),
				timeouts.dataBlock,
				'the next part of the message',
			);
			if (!chunk) break;
			const bytes = writer.write(chunk);
			if (writer.bareLineBreaks > 0) throw bareLineBreak();
			if (writer.eightBit && !eightBitOk) {
				throw missing(
					host,
					'8BITMIME',
					'the message needs: it has 8-bit bytes',
				);
			}
			socket.write(bytes);
			await socket.drained(timeouts.dataBlock);
		}
	} catch (error) {
		// No final dot: the server drops what it has of the message.
		chunks.cancel();
		socket.close(true);
		throw error;
	}
	socket.write(writer.end());
	const end = await socket.reply(
		'the reply to the final dot',
		timeouts.dataEnd,
	);
	if (end.code !== 250) throw refused(host, 'the message', end);
	return end;
}

/** One message: the envelope, then the content. */
export async function transact(
	socket: ClientSocket,
	settings: ClientSettings,
	content: Content,
	ready: Ready,
): Promise<Delivered> {
	const { accepted, rejected } = await envelope(
		socket,
		settings,
		content,
		ready,
	);
	const reply = await data(socket, settings, content, ready);
	return { accepted, rejected, reply };
}
