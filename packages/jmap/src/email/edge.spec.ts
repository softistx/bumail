import { afterEach, describe, expect, test } from 'bun:test';
import {
	type Harness,
	harness,
	MULTIPART,
	SIMPLE,
} from '../server/app.fixtures';
import { htmlText } from './values';

const NO_BOUNDARY = [
	'From: a@example.com',
	'Subject: No boundary',
	'Content-Type: multipart/mixed',
	'',
	'The whole body.',
	'',
].join('\r\n');

describe('edge cases of emails', () => {
	let h: Harness | undefined;
	afterEach(async () => {
		await h?.close();
		h = undefined;
	});

	test('htmlText finds tags after a character whose lowercase is longer', () => {
		expect(htmlText('İİİİ<b>bold</b> <script>x</script>end')).toBe(
			'İİİİ bold    end',
		);
		expect(htmlText('İ<SCRIPT>hidden</SCRIPT>shown')).toBe('İ  shown');
	});

	test('a multipart with no boundary is one opaque part, its content kept', async () => {
		h = await harness();
		const message = await h.add(NO_BOUNDARY);
		const { args } = await h.call('Email/get', {
			ids: [message.id],
			properties: ['bodyStructure', 'attachments'],
		});
		const [email] = args.list;
		expect(email.bodyStructure).toMatchObject({
			partId: '1',
			type: 'multipart/mixed',
			size: 'The whole body.\r\n'.length,
		});
		expect(email.attachments).toHaveLength(1);
		const download = await h.fetch(
			`/jmap/download/${h.alice.id}/${email.bodyStructure.blobId}/part`,
		);
		expect(await download.text()).toBe('The whole body.\r\n');
	});

	test('a name of Object.prototype is not a property', async () => {
		h = await harness();
		const message = await h.add(SIMPLE);
		for (const property of ['toString', 'constructor', '__proto__']) {
			const { args } = await h.call('Email/get', {
				ids: [message.id],
				properties: [property],
			});
			expect(args.type).toBe('invalidArguments');
		}
	});

	test('Mailbox/get past maxQueryScan emails falls back to the store counts: unseen as unreadEmails, email counts as thread counts', async () => {
		h = await harness('memory', { limits: { maxQueryScan: 1 } });
		await h.add(SIMPLE);
		await h.add(MULTIPART);
		// Read by RFC 8621, but not \Seen: past the budget, the store's IMAP
		// unseen stands in, so it counts as unread.
		await h.add(SIMPLE, h.inbox.id, ['$Seen']);
		const unseen = (await h.store.getMailbox(h.alice.id, h.inbox.id))?.unseen;
		expect(unseen).toBe(3);
		for (const properties of [
			null,
			['totalThreads', 'unreadThreads'],
			['unreadEmails'],
		]) {
			const { args } = await h.call('Mailbox/get', {
				ids: [h.inbox.id],
				properties,
			});
			expect(args.type).toBeUndefined();
			const [inbox] = args.list;
			if (properties === null || properties.includes('totalThreads')) {
				expect(inbox.totalThreads).toBe(3);
				expect(inbox.unreadThreads).toBe(unseen);
			}
			if (properties === null || properties.includes('unreadEmails')) {
				expect(inbox.unreadEmails).toBe(unseen);
			}
		}
		const all = await h.call('Mailbox/get', { ids: null, properties: null });
		expect(all.args.type).toBeUndefined();
		for (const mailbox of all.args.list) {
			expect(mailbox.totalThreads).toBe(mailbox.totalEmails);
			expect(mailbox.unreadThreads).toBe(mailbox.unreadEmails);
		}
	});
});
