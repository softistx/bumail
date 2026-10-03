import { describe, expect, test } from 'bun:test';
import { describeMailStore } from '../contract/mail-store.fixtures';
import { MemoryMailStore } from './store';

describeMailStore(
	'MemoryMailStore',
	() => new MemoryMailStore(),
	(maxTombstones) => new MemoryMailStore({ maxTombstones }),
);

describe('MemoryMailStore: maxTombstones', () => {
	test('refuses a bad count', () => {
		expect(() => new MemoryMailStore({ maxTombstones: -1 })).toThrow(
			'maxTombstones',
		);
	});
});
