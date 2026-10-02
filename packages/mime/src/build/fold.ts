import { MimeError } from '../errors';

const LINE = 78;

/**
 * A header field as written: `Name: value`, folded at white space so lines
 * stay within 78 characters where the value allows it (RFC 5322 §2.1.1,
 * §2.2.3). A word longer than a line is never cut. A name or value holding
 * a line break is refused: that is header injection.
 */
export function foldHeader(name: string, value: string): string {
	if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) {
		throw new MimeError(
			'INVALID_OPTION',
			`"${name}" is not a header field name`,
		);
	}
	if (/[\r\n]/.test(value)) {
		throw new MimeError(
			'INVALID_OPTION',
			`The value of ${name} holds a line break`,
		);
	}
	const lines: string[] = [];
	let line = `${name}:`;
	for (const piece of ` ${value}`.split(/(?=[ \t])/)) {
		if (line.length + piece.length > LINE && line.trim() !== `${name}:`) {
			lines.push(line);
			line = piece;
		} else {
			line += piece;
		}
	}
	lines.push(line);
	return lines.join('\r\n');
}
