import { expect, test } from 'bun:test';
import { bytes } from '../contract/fixtures/setup.fixtures';
import {
	describePostgres,
	tableList,
	temporaryStores,
} from './databases.fixtures';
import { PostgresMailStore } from './store';

describePostgres('PostgresMailStore with a server role', (url) => {
	const { admin, create, prefix, tablesFor } = temporaryStores(url);

	/**
	 * A role that may log in and use the tables of `tablePrefix`, if given,
	 * with no `CREATE` on any schema (PostgreSQL 15 and later give PUBLIC
	 * none on `public`); dropped once `body` has run.
	 */
	async function asServer(
		tablePrefix: string | undefined,
		body: (serverUrl: URL) => Promise<void>,
	) {
		const role = `bumail_server_${crypto.randomUUID().slice(0, 8)}`;
		await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'server'`);
		try {
			if (tablePrefix) {
				await admin.unsafe(
					`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableList(tablePrefix).join(', ')} TO ${role}`,
				);
			}
			const serverUrl = new URL(url);
			serverUrl.username = role;
			serverUrl.password = 'server';
			await body(serverUrl);
		} finally {
			await admin.unsafe(`DROP OWNED BY ${role}`);
			await admin.unsafe(`DROP ROLE ${role}`);
		}
	}

	test('once an owner migrated, a role with only SELECT, INSERT, UPDATE and DELETE runs the store', async () => {
		const owner = create();
		await owner.migrate();
		const tablePrefix = tablesFor(owner);
		await asServer(tablePrefix, async (serverUrl) => {
			const store = PostgresMailStore.open({
				sql: serverUrl,
				tablePrefix,
				maxTombstones: 1,
			});
			try {
				const account = await store.createAccount('mary@example.net');
				const inbox = await store.createMailbox(account.id, {
					name: 'INBOX',
					role: 'inbox',
				});
				const trash = await store.createMailbox(account.id, { name: 'Trash' });
				const message = await store.addMessage(account.id, inbox.id, {
					content: bytes('Subject: hi\r\n\r\nhello\r\n'),
				});
				await store.setFlags(account.id, [message.id], { add: ['\\Seen'] });
				await store.moveMessages(account.id, [message.id], inbox.id, trash.id);
				const changes = await store.messageChanges(account.id, message.modseq);
				expect(changes.updated).toEqual([message.id]);
				await store.destroyMessages(account.id, [message.id]);
				await store.deleteMailbox(account.id, trash.id);
				await store.deleteAccount(account.id);
				expect(await store.findAccount('mary@example.net')).toBeUndefined();
			} finally {
				await store.close();
			}
		});
	});

	test('the same role cannot make the tables: the first call says so', async () => {
		const tablePrefix = prefix();
		await asServer(undefined, async (serverUrl) => {
			const store = PostgresMailStore.open({ sql: serverUrl, tablePrefix });
			try {
				await expect(store.findAccount('x')).rejects.toThrow(
					'The PostgreSQL mail store cannot be set up: permission denied for schema public',
				);
			} finally {
				await store.close();
			}
		});
	});
});
