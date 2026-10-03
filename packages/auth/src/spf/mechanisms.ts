import { lowerAscii } from '../text';
import { targetName } from './expand';
import { inNetwork, parseAnswer } from './ip';
import { reverseOf, within } from './ptr';
import type { Mechanism } from './record';
import {
	countLookup,
	countVoid,
	Halt,
	isVoid,
	lookUp,
	MAX_NAMES,
	type Run,
} from './run';

/** Runs a nested check_host() for `include` (§5.2); given by the evaluator, so the two modules do not import each other. */
export type Include = (domain: string) => Promise<boolean>;

/** Whether any address of `name` (A for IPv4 clients, AAAA for IPv6) is in the mechanism's network. */
async function addressMatches(
	run: Run,
	name: string,
	cidr4: number,
	cidr6: number,
	counted: boolean,
): Promise<boolean> {
	const v4 = run.ip.length === 4;
	const records = await lookUp(run, v4 ? 'a' : 'aaaa', name);
	if (counted && isVoid(records)) countVoid(run);
	return records.some((record) => {
		const address = parseAnswer(record.address);
		return (
			address !== undefined && inNetwork(run.ip, address, v4 ? cidr4 : cidr6)
		);
	});
}

/** `mx` (§5.4): the addresses of up to ten MX names; more than ten is `permerror`. */
async function mxMatches(
	run: Run,
	name: string,
	cidr4: number,
	cidr6: number,
): Promise<boolean> {
	const records = await lookUp(run, 'mx', name);
	if (isVoid(records)) countVoid(run);
	if (records.length > MAX_NAMES) {
		throw new Halt(
			'permerror',
			`more than ${MAX_NAMES} MX records for ${name}`,
		);
	}
	for (const record of records) {
		if (record.exchange === '') continue;
		if (await addressMatches(run, record.exchange, cidr4, cidr6, false)) {
			return true;
		}
	}
	return false;
}

/** `ptr` (§5.5): a validated name of the client that is the target or under it. */
async function ptrMatches(run: Run, target: string): Promise<boolean> {
	const reverse = await reverseOf(run);
	if (reverse.void) countVoid(run);
	const domain = lowerAscii(target);
	return reverse.names.some((name) => within(name, domain));
}

/** `exists` (§5.7): any A record at all, whatever the client's family. */
async function existsMatches(run: Run, name: string): Promise<boolean> {
	const records = await lookUp(run, 'a', name);
	if (isVoid(records)) countVoid(run);
	return records.length > 0;
}

/**
 * Whether one mechanism matches the client, for the record of `domain`.
 * A DNS failure, or a limit passed, halts the whole check.
 */
export async function matches(
	run: Run,
	mechanism: Mechanism,
	domain: string,
	include: Include,
): Promise<boolean> {
	switch (mechanism.kind) {
		case 'all':
			return true;
		case 'ip4':
		case 'ip6':
			return inNetwork(run.ip, mechanism.network, mechanism.prefix);
	}
	countLookup(run);
	const target =
		mechanism.target === undefined
			? domain
			: await targetName(run, mechanism.target, domain);
	switch (mechanism.kind) {
		case 'a':
			return addressMatches(
				run,
				target,
				mechanism.cidr4,
				mechanism.cidr6,
				true,
			);
		case 'mx':
			return mxMatches(run, target, mechanism.cidr4, mechanism.cidr6);
		case 'ptr':
			return ptrMatches(run, target);
		case 'exists':
			return existsMatches(run, target);
		case 'include':
			return include(target);
	}
}
