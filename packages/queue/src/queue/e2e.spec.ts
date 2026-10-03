import { afterEach, describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { parseMessage } from '@bumail/mime';
import { createSmtpServer, type SmtpServer } from '@bumail/smtp';
import { MemoryQueueStore } from '../memory/store';
import { createQueue } from './queue';
import { fakeClock, MINUTE, recordEvents } from './queue.fixtures';

interface Received {
	readonly from: string;
	readonly to: readonly string[];
	readonly text: string;
}

let server: SmtpServer | undefined;
afterEach(() => server?.stop(true));

/**
 * A real `@bumail/smtp` server in this process, the MX of example.com and
 * example.net: joe's first RCPT gets a 451, nobody always a 550.
 */
async function destination() {
	const received: Received[] = [];
	let joeRefused = false;
	server = createSmtpServer({
		hostname: 'mx.test',
		localDomains: ['example.com', 'example.net'],
		onRcptTo(path) {
			if (path.address === 'nobody@example.com') {
				return { code: 550, status: '5.1.1', text: 'No such user here' };
			}
			if (path.address === 'joe@example.com' && !joeRefused) {
				joeRefused = true;
				return {
					code: 451,
					status: '4.3.0',
					text: 'Greylisted, come back later',
				};
			}
			return undefined;
		},
		async onData(message) {
			const text = await new Response(message.content).text();
			received.push({ ...message.envelope, text });
		},
	});
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	const resolver = fixtureResolver({
		'example.com': { mx: [{ exchange: 'mx.test', priority: 10 }] },
		'example.net': { mx: [{ exchange: 'mx.test', priority: 10 }] },
		'mx.test': { a: ['127.0.0.1'] },
	});
	return { port, resolver, received };
}

describe('end to end, through a real SMTP server', () => {
	test('a 4xx is followed by a success; a 5xx produces a DSN the sender receives', async () => {
		const { port, resolver, received } = await destination();
		const clock = fakeClock();
		const queue = createQueue({
			store: new MemoryQueueStore(),
			hostname: 'mail.example.net',
			resolver,
			mxPort: port,
			clock,
			random: () => 0,
		});
		const events = recordEvents(queue);
		const message =
			'From: mary@example.net\r\nTo: joe@example.com\r\nSubject: Lunch\r\nMessage-ID: <lunch@example.net>\r\n\r\nNoon?\r\n';
		await queue.enqueue(message, {
			from: 'mary@example.net',
			to: ['joe@example.com', 'nobody@example.com'],
		});

		await queue.deliverDue();
		expect(events.deferred.map((e) => [e.recipient, e.reply?.code])).toEqual([
			['joe@example.com', 451],
		]);
		expect(events.failed.map((e) => [e.recipient, e.reply?.status])).toEqual([
			['nobody@example.com', '5.1.1'],
		]);
		// The DSN, from <>, went to mary's own MX in the same pass.
		const dsn = received.find((r) => r.from === '');
		expect(dsn?.to).toEqual(['mary@example.net']);
		const report = parseMessage(dsn?.text ?? '');
		expect(report.contentType.parameters['report-type']).toBe(
			'delivery-status',
		);
		const status = new TextDecoder().decode(report.children[1]?.content);
		expect(status).toContain('Final-Recipient: rfc822; nobody@example.com');
		expect(status).toContain('Action: failed');
		expect(status).toContain('Status: 5.1.1');
		expect(status).toContain('Diagnostic-Code: smtp; 550 No such user here');
		expect(new TextDecoder().decode(report.children[2]?.content)).toContain(
			'Message-ID: <lunch@example.net>',
		);

		clock.advance(30 * MINUTE);
		await queue.deliverDue();
		const delivered = received.filter((r) => r.from === 'mary@example.net');
		expect(delivered.map((r) => r.to)).toEqual([['joe@example.com']]);
		expect(delivered[0]?.text).toContain(
			'Message-ID: <lunch@example.net>\r\n\r\nNoon?\r\n',
		);
		expect(events.delivered.map((e) => e.recipient)).toEqual([
			'mary@example.net',
			'joe@example.com',
		]);
		expect(await queue.list()).toEqual([]);
	});
});
