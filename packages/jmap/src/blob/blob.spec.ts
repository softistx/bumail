import { afterEach, describe, expect, test } from 'bun:test';
import {
	bytes,
	type Harness,
	harness,
	MULTIPART,
	SIMPLE,
	STORES,
} from '../server/app.fixtures';
import { Uploads } from './uploads';

describe.each(STORES)('blobs on the %s store', (kind) => {
	let h: Harness;
	afterEach(() => h.close());

	test('RFC 8620 §6.1: an upload answers accountId, blobId, type and size; Email/import makes it an email', async () => {
		h = await harness(kind);
		const response = await h.fetch(`/jmap/upload/${h.alice.id}`, {
			method: 'POST',
			headers: { 'content-type': 'message/rfc822' },
			body: SIMPLE,
		});
		expect(response.status).toBe(201);
		const upload = (await response.json()) as Record<string, unknown>;
		expect(upload).toMatchObject({
			accountId: h.alice.id,
			type: 'message/rfc822',
			size: bytes(SIMPLE).length,
		});
		const { args } = await h.call('Email/import', {
			emails: {
				m1: {
					blobId: upload['blobId'],
					mailboxIds: { [h.inbox.id]: true, [h.archive.id]: true },
					keywords: { $seen: true },
					receivedAt: '2022-02-02T02:02:02Z',
				},
			},
		});
		const created = args.created.m1;
		expect(created).toMatchObject({
			blobId: upload['blobId'],
			size: bytes(SIMPLE).length,
		});
		const stored = await h.store.getMessage(h.alice.id, created.id);
		expect(stored?.mailboxes).toHaveLength(2);
		expect(stored?.flags).toEqual(['\\Seen']);
		expect(stored?.receivedAt.toISOString()).toBe('2022-02-02T02:02:02.000Z');
		const missing = await h.call('Email/import', {
			emails: { m2: { blobId: 'nope', mailboxIds: { [h.inbox.id]: true } } },
		});
		expect(missing.args.notCreated.m2.type).toBe('blobNotFound');
	});

	test('Email/set create takes an uploaded blobId too, and #creationIds resolve later in the request', async () => {
		h = await harness(kind);
		const upload = (await (
			await h.fetch(`/jmap/upload/${h.alice.id}`, {
				method: 'POST',
				body: MULTIPART,
			})
		).json()) as { blobId: string };
		const { methodResponses } = await h.api(
			[
				[
					'Email/set',
					{
						accountId: h.alice.id,
						create: {
							k: { blobId: upload.blobId, mailboxIds: { [h.inbox.id]: true } },
						},
					},
					'a',
				],
				[
					'Email/get',
					{ accountId: h.alice.id, ids: ['#k'], properties: ['subject'] },
					'b',
				],
			],
			{ createdIds: {} },
		);
		expect(methodResponses[1]?.[1].list[0].subject).toBe('Re: Report attached');
		const refused = await h.call('Email/set', {
			create: { x: { subject: 'Hi', mailboxIds: { [h.inbox.id]: true } } },
		});
		expect(refused.args.notCreated.x.type).toBe('invalidProperties');
	});

	test('RFC 8620 §6.2: a download serves an email, a part, and a Range', async () => {
		h = await harness(kind);
		const message = await h.add(MULTIPART);
		const whole = await h.fetch(
			`/jmap/download/${h.alice.id}/${message.blobId}/mail.eml?accept=message/rfc822`,
		);
		expect(whole.status).toBe(200);
		expect(whole.headers.get('content-type')).toBe('message/rfc822');
		expect(whole.headers.get('content-disposition')).toContain(
			'filename="mail.eml"',
		);
		expect(await whole.text()).toBe(MULTIPART);
		const range = await h.fetch(
			`/jmap/download/${h.alice.id}/${message.blobId}/mail.eml`,
			{ headers: { range: 'bytes=0-4' } },
		);
		expect(range.status).toBe(206);
		expect(range.headers.get('content-range')).toBe(
			`bytes 0-4/${message.size}`,
		);
		expect(await range.text()).toBe('From:');
		const past = await h.fetch(
			`/jmap/download/${h.alice.id}/${message.blobId}/x`,
			{ headers: { range: `bytes=${message.size}-` } },
		);
		expect(past.status).toBe(416);
		expect(past.headers.get('content-range')).toBe(`bytes */${message.size}`);
		expect(past.headers.get('cache-control')).toBe('no-store');
		expect(past.headers.get('content-disposition')).toBeNull();
		expect(past.headers.get('content-type')).toBeNull();
		expect(await past.text()).toBe('');
		const pdf = await h.fetch(
			`/jmap/download/${h.alice.id}/${message.blobId}_2/report.pdf`,
		);
		expect(pdf.headers.get('content-type')).toBe('application/pdf');
		expect(await pdf.text()).toBe('%PDF-1.4\n');
		const html = await h.fetch(
			`/jmap/download/${h.alice.id}/${message.blobId}_1-2/b.html?accept=text/html`,
		);
		expect(await html.text()).toBe('<p>See the <b>report</b>.</p>');
	});

	test('RFC 9110 §14.1.1 and §14.2: a suffix range of an empty blob serves it whole; one from 0 is a 416', async () => {
		h = await harness(kind);
		const upload = (await (
			await h.fetch(`/jmap/upload/${h.alice.id}`, {
				method: 'POST',
				body: new Uint8Array(0),
			})
		).json()) as { blobId: string; size: number };
		expect(upload.size).toBe(0);
		const url = `/jmap/download/${h.alice.id}/${upload.blobId}/empty`;
		const suffix = await h.fetch(url, { headers: { range: 'bytes=-5' } });
		expect(suffix.status).toBe(200);
		expect(suffix.headers.get('content-range')).toBeNull();
		expect(await suffix.text()).toBe('');
		for (const range of ['bytes=0-', 'bytes=-0']) {
			const refused = await h.fetch(url, { headers: { range } });
			expect(refused.status).toBe(416);
			expect(refused.headers.get('content-range')).toBe('bytes */0');
		}
	});

	test("another account's blob is never found, by download or by import", async () => {
		h = await harness(kind);
		const bobs = await h.store.addMessage(h.bob.id, h.bobInbox.id, {
			content: bytes(SIMPLE),
		});
		const asAlice = await h.fetch(
			`/jmap/download/${h.alice.id}/${bobs.blobId}/x`,
		);
		expect(asAlice.status).toBe(404);
		const otherAccount = await h.fetch(
			`/jmap/download/${h.bob.id}/${bobs.blobId}/x`,
		);
		expect(otherAccount.status).toBe(404);
		const upload = await h.fetch(`/jmap/upload/${h.bob.id}`, {
			method: 'POST',
			body: 'x',
		});
		expect(upload.status).toBe(404);
		const imported = await h.call('Email/import', {
			emails: {
				m: { blobId: bobs.blobId, mailboxIds: { [h.inbox.id]: true } },
			},
		});
		expect(imported.args.notCreated.m.type).toBe('blobNotFound');
	});
});

describe('uploads in memory', () => {
	test('expire after their TTL, and hold at most the quota per account', () => {
		let now = 0;
		const uploads = new Uploads(10, 5, () => now);
		const first = uploads.add('a', bytes('abc'), 'text/plain');
		expect(first?.blobId).toHaveLength(64);
		expect(uploads.add('a', bytes('defg'), 'text/plain')).toBeUndefined();
		expect(uploads.add('b', bytes('defg'), 'text/plain')).toBeDefined();
		expect(uploads.add('a', bytes('abc'), 'text/plain')).toBeDefined();
		now = 10_000;
		expect(uploads.get('a', first?.blobId ?? '')).toBeUndefined();
		expect(uploads.add('a', bytes('defg'), 'text/plain')).toBeDefined();
	});
});
