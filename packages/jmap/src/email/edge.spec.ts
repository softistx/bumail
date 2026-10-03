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

	test('Mailbox/get counts threads by reading at most maxQueryScan emails', async () => {
		h = await harness('memory', { limits: { maxQueryScan: 1 } });
		await h.add(SIMPLE);
		await h.add(MULTIPART);
		const counted = await h.call('Mailbox/get', {
			ids: [h.inbox.id],
			properties: ['totalThreads'],
		});
		expect(counted.args.type).toBe('tooLarge');
		const plain = await h.call('Mailbox/get', {
			ids: [h.inbox.id],
			properties: ['totalEmails'],
		});
		expect(plain.args.list[0].totalEmails).toBe(2);
	});
});
