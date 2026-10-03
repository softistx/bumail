import { describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blobIdOf } from '../contract/blob';
import { bytes, streamOf } from '../contract/fixtures/setup.fixtures';
import { BlobFiles } from './blobs';
import { temporaryStores } from './directories.fixtures';

const { directory, open } = temporaryStores();

/** Every file under the blobs, staging ones included, relative to it. */
const filesUnder = (at: string) =>
	readdirSync(at, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(at.length + 1))
		.sort();

describe('BlobFiles', () => {
	test('writes content under its SHA-256, by its first two digits', async () => {
		const at = directory();
		const blobs = new BlobFiles(at);
		const written = await blobs.write(bytes('hello'));
		const blobId = blobIdOf(bytes('hello'));
		expect(written).toEqual({ blobId, size: 5 });
		expect(filesUnder(at)).toEqual([join(blobId.slice(0, 2), blobId)]);
		expect(await (await blobs.file(blobId))?.text()).toBe('hello');
	});

	test('the same bytes are written once, given whole or as a stream', async () => {
		const at = directory();
		const blobs = new BlobFiles(at);
		const whole = await blobs.write(bytes('same bytes'));
		const streamed = await blobs.write(
			streamOf([bytes('same '), bytes('bytes')]),
		);
		expect(streamed).toEqual(whole);
		expect(filesUnder(at)).toHaveLength(1);
	});

	test('a stream that fails is INVALID and leaves nothing behind', async () => {
		const at = directory();
		const blobs = new BlobFiles(at);
		await expect(
			blobs.write(streamOf([bytes('half')], new Error('reset'))),
		).rejects.toMatchObject({ name: 'StoreError', code: 'INVALID' });
		await expect(blobs.write(streamOf(['text']))).rejects.toMatchObject({
			code: 'INVALID',
		});
		expect(filesUnder(at)).toEqual([]);
	});

	test('a blob survives a reopen; staging files a crash left do not', async () => {
		const at = directory();
		const { blobId } = await new BlobFiles(at).write(bytes('kept'));
		writeFileSync(join(at, 'crashed.staging'), 'half a message');
		const again = new BlobFiles(at);
		expect(await (await again.file(blobId))?.text()).toBe('kept');
		expect(filesUnder(at)).toEqual([join(blobId.slice(0, 2), blobId)]);
	});

	test('opening a store removes the blobs no account holds, and keeps the rest', async () => {
		const at = directory();
		const before = open(at);
		const account = await before.createAccount('mary@example.net');
		const inbox = await before.createMailbox(account.id, { name: 'INBOX' });
		const held = await before.addMessage(account.id, inbox.id, {
			content: bytes('held'),
		});
		before.close();
		const blobs = new BlobFiles(join(at, 'blobs'));
		const orphan = await blobs.write(bytes('orphan'));
		const shard = join(at, 'blobs', orphan.blobId.slice(0, 2));
		writeFileSync(join(shard, 'not-a-blob'), 'left alone');
		const after = open(at);
		expect(await blobs.file(orphan.blobId)).toBeUndefined();
		expect(filesUnder(join(at, 'blobs'))).toEqual(
			[
				join(held.blobId.slice(0, 2), held.blobId),
				join(orphan.blobId.slice(0, 2), 'not-a-blob'),
			].sort(),
		);
		const content = await after.readContent(account.id, held.blobId);
		expect(await content?.text()).toBe('held');
	});

	test('a directory named like a blob does not stop the store opening', () => {
		const at = directory();
		open(at).close();
		const name = blobIdOf(bytes('a directory'));
		const odd = join(at, 'blobs', name.slice(0, 2), name);
		mkdirSync(odd, { recursive: true });
		open(at).close();
		expect(readdirSync(odd)).toEqual([]);
	});
});

describe('BlobFiles: reading and removing', () => {
	test('reads lazily, and slices a range', async () => {
		const blobs = new BlobFiles(directory());
		const { blobId } = await blobs.write(bytes('0123456789'));
		const file = (await blobs.file(blobId)) as Blob;
		expect(file.size).toBe(10);
		expect(file.type).toBe('');
		expect(await file.slice(2, 5).text()).toBe('234');
	});

	test('an id that is no SHA-256 names no file, whatever path it spells', async () => {
		const blobs = new BlobFiles(directory());
		for (const id of ['../../etc/passwd', 'ABC', '', 'a'.repeat(63)]) {
			expect(blobs.pathOf(id)).toBeUndefined();
			expect(await blobs.file(id)).toBeUndefined();
		}
		expect(await blobs.file(blobIdOf(bytes('never written')))).toBeUndefined();
	});

	test('removing a blob removes its file; removing it again is fine', async () => {
		const at = directory();
		const blobs = new BlobFiles(at);
		const { blobId } = await blobs.write(bytes('gone'));
		await blobs.remove(blobId);
		await blobs.remove(blobId);
		await blobs.remove('../nope');
		expect(filesUnder(at)).toEqual([]);
		expect(await blobs.file(blobId)).toBeUndefined();
	});
});
