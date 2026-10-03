#!/usr/bin/env bun
/**
 * Refreshes the Public Suffix List `@bumail/auth` embeds for DMARC's
 * organizational domain (RFC 7489 §3.2).
 *
 *   bun run scripts/refresh-psl.ts            # download from publicsuffix.org
 *   bun run scripts/refresh-psl.ts list.dat   # or encode a file already fetched
 *
 * It writes `packages/auth/src/dmarc/psl-data.ts`: every rule of both
 * sections (ICANN and private) as one compact trie, a third of the list's
 * size. Single-label rules are dropped, since the default rule `*` says
 * the same; names are written in their A-labels, as `@bumail/dns`'
 * `normalizeName` gives them. The list is MPL 2.0, and the notice is kept
 * in the generated file.
 *
 * Commit the result with a changeset for `@bumail/auth`: the snapshot
 * ships in the package, so a refresh is a patch release.
 */

import { domainToASCII } from 'node:url';

const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat';
const TARGET = new URL(
	'../packages/auth/src/dmarc/psl-data.ts',
	import.meta.url,
);

type Trie = { rule: boolean; readonly kids: Map<string, Trie> };

/** The rules of a `public_suffix_list.dat`, as written: comments and blank lines dropped. */
export function rulesOf(list: string): string[] {
	const rules: string[] = [];
	for (const line of list.split('\n')) {
		const rule = line.trim().split(/\s/)[0] ?? '';
		if (rule !== '' && !rule.startsWith('//')) rules.push(rule);
	}
	return rules;
}

/** A rule's labels in A-labels, rightmost first, with `!` kept on the exception's own label. */
function labelsOf(rule: string): string[] {
	const exception = rule.startsWith('!');
	const body = exception ? rule.slice(1) : rule;
	const wild = body.startsWith('*.');
	const name = wild ? body.slice(2) : body;
	const ascii = domainToASCII(name);
	if (ascii === '') throw new Error(`${rule} is not a name`);
	const labels = ascii.split('.');
	if (wild) labels.unshift('*');
	if (exception) labels[0] = `!${labels[0]}`;
	return labels.reverse();
}

function serialize(node: Trie): string {
	return [...node.kids.keys()]
		.sort()
		.map((label) => {
			const kid = node.kids.get(label) as Trie;
			if (kid.kids.size === 0) return label;
			return `${label}${kid.rule ? '' : '?'}(${serialize(kid)})`;
		})
		.join(',');
}

/**
 * The rules as one string: `label[?][(children)]`, comma-separated,
 * rightmost label first. `?` marks a name that is only on the path to a
 * rule, not a rule itself; a leaf is always a rule.
 */
export function encodeRules(rules: readonly string[]): string {
	const root: Trie = { rule: false, kids: new Map() };
	for (const rule of rules) {
		const labels = labelsOf(rule);
		if (labels.length < 2) continue;
		let node = root;
		for (const label of labels) {
			let kid = node.kids.get(label);
			if (kid === undefined) {
				kid = { rule: false, kids: new Map() };
				node.kids.set(label, kid);
			}
			node = kid;
		}
		node.rule = true;
	}
	return serialize(root);
}

/** The `// VERSION:` line of the list, or `unknown`. */
export function versionOf(list: string): string {
	return /^\/\/ VERSION: (\S+)$/m.exec(list)?.[1] ?? 'unknown';
}

/** The generated module. */
export function moduleOf(list: string): string {
	return `/*!
 * The Public Suffix List, ${versionOf(list)}, from ${SOURCE}.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 * Encoded by scripts/refresh-psl.ts in the bumail repository: do not edit.
 */

/** The snapshot's \`VERSION\` line. */
export const PSL_VERSION: string = '${versionOf(list)}';

/** Every rule of more than one label, as a trie: see \`decodeRules\` in \`psl.ts\`. */
export const PSL_RULES: string =
	'${encodeRules(rulesOf(list))}';
`;
}

if (import.meta.main) {
	const file = process.argv[2];
	const list =
		file === undefined
			? await (await fetch(SOURCE)).text()
			: await Bun.file(file).text();
	if (!list.includes('===BEGIN ICANN DOMAINS===')) {
		throw new Error('that is not the Public Suffix List');
	}
	await Bun.write(TARGET, moduleOf(list));
	console.log(`wrote ${TARGET.pathname} (${versionOf(list)})`);
}
