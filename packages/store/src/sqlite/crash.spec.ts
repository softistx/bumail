import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { blobIdOf } from '../contract/blob';
import { bytes } from '../contract/fixtures/setup.fixtures';
import { CONTENT, CRASHED } from './crash.fixtures';
import { temporaryStores } from './directories.fixtures';

const { directory, open } = temporaryStores();

describe('SqliteMailStore: a crash while adding', () => {
	test('between the blob and the commit: never a row naming no blob, and the blob is swept at reopen', async () => {
		const at = directory();
		const before = open(at);
		const account = await before.createAccount('mary@example.net');
		const inbox = await before.createMailbox(account.id, { name: 'INBOX' });
		before.close();

		const child = Bun.spawnSync([
			process.execPath,
			join(import.meta.dir, 'crash.fixtures.ts'),
			at,
			account.id,
			inbox.id,
		]);
		expect(child.exitCode).toBe(CRASHED);

		// The content reached the disk before the transaction began…
		const blobId = blobIdOf(bytes(CONTENT));
		const file = join(at, 'blobs', blobId.slice(0, 2), blobId);
		expect(existsSync(file)).toBe(true);
		// …and no row names it: the add never happened, and the reopen
		// removes the blob nothing holds.
		const after = open(at);
		expect(existsSync(file)).toBe(false);
		expect(await after.getMailbox(account.id, inbox.id)).toMatchObject({
			messages: 0,
			uidNext: 1,
			highestModseq: inbox.highestModseq,
		});
		expect((await after.listAccountMessages(account.id)).total).toBe(0);
		expect(await after.readContent(account.id, blobId)).toBeUndefined();
		// The same bytes added again write the blob anew.
		const message = await after.addMessage(account.id, inbox.id, {
			content: bytes(CONTENT),
		});
		expect(message.blobId).toBe(blobId);
		expect(await (await after.readContent(account.id, blobId))?.text()).toBe(
			CONTENT,
		);
	});
});
