import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Harness, harness, SIMPLE } from './app.fixtures';

/** The part of jmap-jam's client this spec uses. */
interface Jam {
	readonly session: Promise<any>;
	readonly api: any;
	getPrimaryAccount(): Promise<string>;
	uploadBlob(
		accountId: string,
		blob: Blob,
	): Promise<{ blobId: string; size: number }>;
	downloadBlob(options: Record<string, string>): Promise<Response>;
	requestMany(
		build: (r: any) => Record<string, any>,
	): Promise<[Record<string, any>, unknown]>;
}

/**
 * jmap-jam's types import jmap-rfc-types' `.ts` sources with a `.ts`
 * extension, which this package's strict `tsc` refuses even under
 * `skipLibCheck`: it is loaded by a name tsc does not follow, and typed by
 * the interface above.
 */
const JAM: string = 'jmap-jam';
const { default: JamClient } = (await import(JAM)) as {
	default: new (options: { sessionUrl: string; bearerToken: string }) => Jam;
};

/**
 * Interop with jmap-jam, a JMAP client on npm, over a real socket: it
 * reads the session, its URLs and limits, and speaks to the server as a
 * client written elsewhere does.
 */
describe('interop with jmap-jam', () => {
	let h: Harness;
	let server: ReturnType<typeof Bun.serve>;
	let jam: Jam;
	let handler: (request: Request) => Response | Promise<Response> = () =>
		new Response(null, { status: 503 });

	beforeAll(async () => {
		server = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			fetch: (request) => handler(request),
		});
		const origin = `http://127.0.0.1:${server.port}`;
		h = await harness('sqlite', { origin });
		handler = (request) => h.host.fetch(request);
		jam = new JamClient({
			sessionUrl: `${origin}/.well-known/jmap`,
			bearerToken: 'alice-token',
		});
	});

	afterAll(async () => {
		server.stop(true);
		await h.close();
	});

	test('reads the session and the primary account', async () => {
		expect(await jam.getPrimaryAccount()).toBe(h.alice.id);
		const session = await jam.session;
		expect(
			session.capabilities['urn:ietf:params:jmap:core'].maxCallsInRequest,
		).toBe(16);
	});

	test('lists mailboxes, uploads and imports an email, then queries and reads it with a back-reference', async () => {
		const accountId = h.alice.id;
		const [mailboxes] = await jam.api.Mailbox.get({ accountId });
		const inbox = mailboxes.list.find(
			(mailbox: { role: string }) => mailbox.role === 'inbox',
		);
		expect(inbox?.id).toBe(h.inbox.id);
		const upload = await jam.uploadBlob(
			accountId,
			new Blob([SIMPLE], { type: 'message/rfc822' }),
		);
		expect(upload.size).toBe(new TextEncoder().encode(SIMPLE).length);
		const [imported] = await jam.api.Email.import({
			accountId,
			emails: {
				one: {
					blobId: upload.blobId,
					mailboxIds: { [h.inbox.id]: true },
					keywords: {},
				},
			},
		});
		const id = imported.created?.['one']?.id;
		expect(id).toBeString();
		const [{ emails }] = await jam.requestMany((r: any) => {
			const ids = r.Email.query({
				accountId,
				filter: { inMailbox: h.inbox.id },
			});
			const emails = r.Email.get({
				accountId,
				ids: ids.$ref('/ids'),
				properties: ['subject', 'from'],
			});
			return { ids, emails };
		});
		expect(emails.list).toEqual([
			{
				id: id as string,
				subject: 'Saying Hello',
				from: [{ name: 'John Doe', email: 'jdoe@machine.example' }],
			},
		]);
		const [set] = await jam.api.Email.set({
			accountId,
			update: { [id as string]: { 'keywords/$seen': true } },
		});
		expect(set.updated).toEqual({ [id as string]: null });
	});

	test('downloads a blob', async () => {
		const message = await h.add(SIMPLE);
		const response = await jam.downloadBlob({
			accountId: h.alice.id,
			blobId: message.blobId,
			mimeType: 'message/rfc822',
			fileName: 'hello.eml',
		});
		expect(await response.text()).toBe(SIMPLE);
	});
});
