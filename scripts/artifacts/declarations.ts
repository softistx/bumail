/** Marks a string literal's place in the code: its index in `strings`. */
const MARK = '\u0001';
const LITERAL = `${MARK}(\\d+)${MARK}`;

/** Every form a declaration file names a module in, its specifier a literal. */
const FORMS = [
	// import … from 'x', import type … from 'x', export … from 'x', export * from 'x'
	new RegExp(`\\b(?:import|export)\\b[^;${MARK}]*?\\bfrom\\s*${LITERAL}`, 'g'),
	// import 'x'
	new RegExp(`\\bimport\\s*${LITERAL}`, 'g'),
	// import('x').T
	new RegExp(`\\bimport\\s*\\(\\s*${LITERAL}\\s*\\)`, 'g'),
	// import x = require('x')
	new RegExp(
		`\\bimport\\s+[\\w$]+\\s*=\\s*require\\s*\\(\\s*${LITERAL}\\s*\\)`,
		'g',
	),
];

/** `/// <reference types="x" />`, which is a comment to everything but tsc. */
const REFERENCE_TYPES =
	/^\s*\/\/\/\s*<reference\s+types\s*=\s*(["'])([^"']+)\1/gm;

/**
 * The code of a declaration file with its comments removed and each string
 * literal replaced by a mark, so that neither a JSDoc example nor a string
 * literal type can pass for an import.
 */
function codeOf(text: string): { code: string; strings: string[] } {
	const strings: string[] = [];
	let code = '';
	let i = 0;
	while (i < text.length) {
		const char = text[i] as string;
		const next = text[i + 1];
		if (char === '/' && next === '/') {
			const end = text.indexOf('\n', i);
			i = end < 0 ? text.length : end;
		} else if (char === '/' && next === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 2;
			code += ' ';
		} else if (char === '"' || char === "'" || char === '`') {
			let value = '';
			i++;
			while (i < text.length && text[i] !== char) {
				if (text[i] === '\\') i++;
				value += text[i] ?? '';
				i++;
			}
			i++;
			code += `${MARK}${strings.push(value) - 1}${MARK}`;
		} else {
			code += char;
			i++;
		}
	}
	return { code, strings };
}

/**
 * The modules a `.d.ts` names, read without TypeScript's own API, which
 * TypeScript 7 no longer exports: every `import` and `export … from`
 * (type-only included), `import('x')` in a type, `import x = require('x')`,
 * and `/// <reference types="x" />`. Built for what tsc emits; a specifier
 * that is not a literal is out of its reach.
 */
export function declarationSpecifiers(text: string): string[] {
	const found = [...text.matchAll(REFERENCE_TYPES)].map(
		(match) => match[2] as string,
	);
	const { code, strings } = codeOf(text);
	for (const form of FORMS) {
		for (const match of code.matchAll(form)) {
			found.push(strings[Number(match[1])] as string);
		}
	}
	return found;
}
