import { afterEach, describe, expect, test } from 'bun:test';
import {
	type Harness,
	harness,
	MULTIPART,
	SIMPLE,
	STORES,
} from '../server/app.fixtures';

describe.each(STORES)('Email/get on the %s store', (kind) => {
	let h: Harness;
	afterEach(() => h.close());

	test('RFC 8621 §4.1: metadata, header and body properties of a multipart email', async () => {
		h = await harness(kind);
		const message = await h.add(MULTIPART, h.inbox.id, [
			'\\Seen',
			'\\Deleted',
			'work',
		]);
		const { args } = await h.call('Email/get', {
			ids: [message.id],
			fetchTextBodyValues: true,
		});
		const [email] = args.list;
		expect(email).toMatchObject({
			id: message.id,
			blobId: message.blobId,
			threadId: message.threadId,
			mailboxIds: { [h.inbox.id]: true },
			keywords: { $seen: true, work: true },
			size: message.size,
			subject: 'Re: Report attached',
			from: [{ name: 'René', email: 'rene@example.com' }],
			inReplyTo: ['1234@local.machine.example'],
			messageId: null,
			sentAt: '2027-02-02T10:00:00Z',
			hasAttachment: true,
			preview: 'See the report.',
		});
		expect(email.textBody.map((p: { partId: string }) => p.partId)).toEqual([
			'1.1',
		]);
		expect(email.htmlBody.map((p: { partId: string }) => p.partId)).toEqual([
			'1.2',
		]);
		expect(email.attachments[0]).toMatchObject({
			partId: '2',
			name: 'report.pdf',
			type: 'application/pdf',
			size: 9,
			disposition: 'attachment',
		});
		expect(email.bodyValues).toEqual({
			'1.1': {
				value: 'See the report.',
				isEncodingProblem: false,
				isTruncated: false,
			},
		});
	});

	test('RFC 8621 §4.1.2: header: forms, :all, and bodyStructure', async () => {
		h = await harness(kind);
		const message = await h.add(MULTIPART);
		const { args } = await h.call('Email/get', {
			ids: [message.id],
			properties: [
				'header:Subject',
				'header:Subject:asText',
				'header:To:asGroupedAddresses',
				'header:X-None:all',
				'bodyStructure',
			],
			bodyProperties: ['type', 'partId'],
		});
		const [email] = args.list;
		expect(email['header:Subject']).toBe('Re: Report attached');
		expect(email['header:To:asGroupedAddresses']).toEqual([
			{ name: null, addresses: [{ name: null, email: 'alice@example.com' }] },
			{ name: 'Team', addresses: [{ name: null, email: 'bob@example.com' }] },
		]);
		expect(email['header:X-None:all']).toEqual([]);
		expect(email.bodyStructure.type).toBe('multipart/mixed');
		expect(email.bodyStructure.subParts[0].subParts[1]).toEqual({
			type: 'text/html',
			partId: '1.2',
			subParts: null,
		});
		const bad = await h.call('Email/get', {
			ids: [message.id],
			properties: ['header:Bad Name'],
		});
		expect(bad.args.type).toBe('invalidArguments');
	});

	test('maxBodyValueBytes truncates a value on a character boundary', async () => {
		h = await harness(kind);
		const message = await h.add(SIMPLE);
		const { args } = await h.call('Email/get', {
			ids: [message.id],
			properties: ['bodyValues'],
			fetchAllBodyValues: true,
			maxBodyValueBytes: 10,
		});
		expect(args.list[0].bodyValues['1']).toEqual({
			value: 'This is a ',
			isEncodingProblem: false,
			isTruncated: true,
		});
	});
});
