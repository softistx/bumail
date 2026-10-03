import type { Outcome } from './check';
import { expand, targetName } from './expand';
import { parseMacroString } from './macro';
import { Halt, lookUp, type Run } from './run';

/**
 * The explanation for a `fail` (§6.2): the TXT record at the `exp=`
 * target, its macros expanded. It costs no lookup of the ten and no void
 * lookup. Anything wrong — no record or more than one, a DNS error, a
 * syntax error, a character outside printable ASCII, the deadline — gives
 * no explanation, never another result.
 */
export async function explain(
	run: Run,
	exp: NonNullable<Outcome['exp']>,
): Promise<string | undefined> {
	try {
		const name = await targetName(run, exp.spec, exp.domain);
		const records = await lookUp(run, 'txt', name);
		if (records.length !== 1) return undefined;
		const parsed = parseMacroString(
			(records[0] as { text: string }).text,
			'explanation',
		);
		if (typeof parsed === 'string') return undefined;
		return await expand(run, parsed.parts, exp.domain);
	} catch (error) {
		if (error instanceof Halt) return undefined;
		throw error;
	}
}
