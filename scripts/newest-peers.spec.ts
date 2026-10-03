import { describe, expect, test } from 'bun:test';
import { type Manifest, newest, rewrite } from './newest-peers';

test('the newest alternative of a range, none for a single one', () => {
	expect(newest('^6.0.3 || ^7.0.0')).toBe('^7.0.0');
	expect(newest('^16.11.0 || ^17.0.0')).toBe('^17.0.0');
	expect(newest('^4.6.5')).toBeUndefined();
});

const root: Manifest = {
	devDependencies: { typescript: '~6.0.3' },
	overrides: { typescript: '~6.0.3', graphql: '^16.11.0' },
};
const pkg = (name: string, manifest: Manifest = {}): Manifest => ({
	name,
	peerDependencies: { typescript: '^6.0.3 || ^7.0.0' },
	...manifest,
});

describe('rewrite', () => {
	test('a package’s own devDependency, the root’s, and every override', () => {
		const graphql = pkg('@alxia/graphql', {
			peerDependencies: {
				graphql: '^16.11.0 || ^17.0.0',
				typescript: '^6.0.3 || ^7.0.0',
			},
			devDependencies: { graphql: '^16.11.0' },
		});
		const result = rewrite(root, new Map([['g', graphql]]));
		expect(result.packages.get('g')?.devDependencies).toEqual({
			graphql: '^17.0.0',
		});
		expect(result.root.devDependencies).toEqual({ typescript: '^7.0.0' });
		expect(result.root.overrides).toEqual({
			typescript: '^7.0.0',
			graphql: '^17.0.0',
		});
		expect(graphql.devDependencies).toEqual({ graphql: '^16.11.0' });
	});

	test('a range nobody installs fails, rather than pass untested', () => {
		const lonely = pkg('@alxia/x', {
			peerDependencies: { zod: '^4.0.0 || ^5.0.0' },
		});
		expect(() => rewrite(root, new Map([['x', lonely]]))).toThrow(
			"add it to @alxia/x's devDependencies",
		);
	});

	test('packages disagreeing on the newest fails', () => {
		const other = pkg('@alxia/y', {
			peerDependencies: { typescript: '^6.0.3 || ^8.0.0' },
		});
		expect(() =>
			rewrite(
				root,
				new Map([
					['a', pkg('@alxia/a')],
					['y', other],
				]),
			),
		).toThrow('disagree on the newest typescript');
	});

	test('nothing with alternatives: nothing to test', () => {
		const single = { name: '@alxia/z', peerDependencies: { zod: '^4.6.5' } };
		expect(() => rewrite(root, new Map([['z', single]]))).toThrow(
			'nothing newer to test',
		);
	});
});
