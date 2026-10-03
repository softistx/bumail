import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { blobIdOf } from '../contract/blob';
import { bytes } from '../contract/fixtures/setup.fixtures';
import { BlobFiles } from './blobs';
import { BlobKeeper } from './content';
import { temporaryStores } from './directories.fixtures';

const { directory } = temporaryStores();

/** A keeper whose database holds the blobs in `held`. */
function keeper() {
	const held = new Set<string>();
	const files = new BlobFiles(directory());
	return { held, files, blobs: new BlobKeeper(files, (id) => held.has(id)) };
}

describe('BlobKeeper', () => {
	test('a blob written for an add is never collected before the add settles', async () => {
		const { files, blobs } = keeper();
		const { blobId } = await blobs.write(bytes('pending'));
		const path = files.pathOf(blobId) as string;
		await blobs.collect([blobId]);
		expect(existsSync(path)).toBe(true);
		blobs.settle(blobId);
		await blobs.collect([blobId]);
		expect(existsSync(path)).toBe(false);
	});

	test('the same bytes written while a removal runs are on disk once both are done', async () => {
		const { files, blobs } = keeper();
		const blobId = blobIdOf(bytes('both'));
		await files.write(bytes('both'));
		const [, written] = await Promise.all([
			blobs.collect([blobId]),
			blobs.write(bytes('both')),
		]);
		expect(written.blobId).toBe(blobId);
		expect(existsSync(files.pathOf(blobId) as string)).toBe(true);
		blobs.settle(blobId);
	});

	test('a blob the database holds is kept; two adds of it settle one by one', async () => {
		const { held, files, blobs } = keeper();
		const { blobId } = await blobs.write(bytes('held'));
		await blobs.write(bytes('held'));
		const path = files.pathOf(blobId) as string;
		blobs.settle(blobId);
		await blobs.collect([blobId]);
		expect(existsSync(path)).toBe(true);
		blobs.settle(blobId);
		held.add(blobId);
		await blobs.collect([blobId]);
		expect(existsSync(path)).toBe(true);
		held.delete(blobId);
		await blobs.collect([blobId]);
		expect(existsSync(path)).toBe(false);
	});
});
