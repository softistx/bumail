import { expect, test } from 'bun:test';
import { didYouMean } from './suggest';

const KNOWN = ['maxMessageSize', 'maxConnections', 'dmarc', 'mx', 'imaps'];

test('finds the key a typo, a case or snake_case meant', () => {
	expect(didYouMean('maxMesageSize', KNOWN)).toBe('maxMessageSize');
	expect(didYouMean('max_connections', KNOWN)).toBe('maxConnections');
	expect(didYouMean('MaxConnections', KNOWN)).toBe('maxConnections');
	expect(didYouMean('dmark', KNOWN)).toBe('dmarc');
	expect(didYouMean('imap', KNOWN)).toBe('imaps');
});

test('suggests nothing when no key is close', () => {
	expect(didYouMean('colour', KNOWN)).toBeUndefined();
	expect(didYouMean('xyz', KNOWN)).toBeUndefined();
});
