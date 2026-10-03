import { describe, expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
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

	test('a blob written beside a store survives the store reopening', async () => {
		const at = directory();
		open(at).close();
		const { blobId } = await new BlobFiles(join(at, 'blobs')).write(
			bytes('mail'),
		);
		open(at);
		const file = await new BlobFiles(join(at, 'blobs')).file(blobId);
		expect(await file?.text()).toBe('mail');
	});
});

describe('BlobFiles: reading and removing', () => {
	test('reads lazily, and slices a range', async () => {
		const blobs = new BlobFiles(directory());
		const { blobId } = await blobs.write(bytes('0123456789'));
		const file = (await blobs.file(blobId)) as Blob;
		expect(file.size).toBe(10);
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
