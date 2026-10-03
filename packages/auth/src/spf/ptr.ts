import { type Ip, ipText, parseAnswer } from './ip';
import {
	Halt,
	isVoid,
	lookUp,
	lookUpLeniently,
	MAX_NAMES,
	type Reverse,
	type Run,
} from './run';

function sameIp(a: Ip, b: Ip): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Whether `name` has an address equal to the client's (§5.5's validation); a DNS error skips it. */
async function validates(run: Run, name: string): Promise<boolean> {
	const type = run.ip.length === 4 ? 'a' : 'aaaa';
	const answers = await lookUpLeniently(run, type, name);
	return answers.some((record) => {
		const address = parseAnswer(record.address);
		return address !== undefined && sameIp(address, run.ip);
	});
}

async function lookUpReverse(run: Run): Promise<Reverse> {
	let names: readonly string[];
	try {
		const records = await lookUp(run, 'ptr', ipText(run.ip));
		if (records.length === 0) return { void: isVoid(records), names: [] };
		names = records.slice(0, MAX_NAMES).map((record) => record.name);
	} catch (error) {
		if (error instanceof Halt && error.late) throw error;
		return { void: false, names: [] };
	}
	const valid = await Promise.all(names.map((name) => validates(run, name)));
	return { void: false, names: names.filter((_, i) => valid[i]) };
}

/**
 * The client's validated names (§5.5): its PTR names, the first ten only,
 * each kept when it has the client's address. Looked up once per check,
 * for the `ptr` mechanism and `%{p}` alike. A DNS error gives no names.
 */
export function reverseOf(run: Run): Promise<Reverse> {
	run.reverse ??= lookUpReverse(run);
	return run.reverse;
}

/** Whether `name` is `domain` or one of its subdomains; both lowercase. */
export function within(name: string, domain: string): boolean {
	return name === domain || name.endsWith(`.${domain}`);
}

/**
 * `%{p}` (§7.3): the validated name that is `domain`, else one of its
 * subdomains, else any; `unknown` when there is none.
 */
export async function validatedName(run: Run, domain: string): Promise<string> {
	const { names } = await reverseOf(run);
	return (
		names.find((name) => name === domain) ??
		names.find((name) => within(name, domain)) ??
		names[0] ??
		'unknown'
	);
}
