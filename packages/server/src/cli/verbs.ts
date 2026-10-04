import { ServerError } from '../errors';

/** What manages the directory: `bumail <noun> <verb> …`. */
export type Noun = 'domain' | 'user' | 'alias' | 'dkim';

/** Where a new password comes from: never the command line. */
export type PasswordSource =
	| { readonly from: 'prompt' }
	| { readonly from: 'stdin' }
	| { readonly from: 'file'; readonly file: string };

interface VerbSpec {
	/** Operands, at least and at most. */
	readonly min: number;
	readonly max: number;
	/** What they are, for the usage message. */
	readonly operands: string;
	/** Takes a new password. */
	readonly password?: boolean;
	/** Takes `--purge`. */
	readonly purge?: boolean;
	/** Takes `--selector` and `--replace`. */
	readonly key?: boolean;
}

/** Each noun's verbs. */
export const VERBS: Readonly<Record<Noun, Readonly<Record<string, VerbSpec>>>> =
	{
		domain: {
			add: { min: 1, max: 1, operands: 'one domain' },
			list: { min: 0, max: 0, operands: 'nothing' },
			remove: { min: 1, max: 1, operands: 'one domain' },
		},
		user: {
			add: { min: 1, max: 1, operands: 'one address', password: true },
			list: { min: 0, max: 1, operands: 'a domain at most' },
			passwd: { min: 1, max: 1, operands: 'one address', password: true },
			disable: { min: 1, max: 1, operands: 'one address' },
			enable: { min: 1, max: 1, operands: 'one address' },
			remove: { min: 1, max: 1, operands: 'one address', purge: true },
		},
		alias: {
			add: {
				min: 2,
				max: Number.POSITIVE_INFINITY,
				operands: 'an address, then one or more users',
			},
			list: { min: 0, max: 1, operands: 'a domain at most' },
			remove: { min: 1, max: 1, operands: 'one address' },
		},
		dkim: {
			generate: { min: 1, max: 1, operands: 'one domain', key: true },
			show: { min: 1, max: 1, operands: 'one domain' },
			list: { min: 0, max: 0, operands: 'nothing' },
			remove: { min: 1, max: 1, operands: 'one domain' },
		},
	};

/** A directory command: `bumail <noun> <verb> <operands>`. */
export type ManageArgs = {
	readonly kind: 'manage';
	readonly noun: Noun;
	readonly verb: string;
	readonly operands: readonly string[];
	readonly config: string | undefined;
	/** For `user add` and `user passwd`. */
	readonly password: PasswordSource | undefined;
	/** `user remove --purge`. */
	readonly purge: boolean;
	/** `dkim generate --selector`. */
	readonly selector: string | undefined;
	/** `dkim generate --replace`. */
	readonly replace: boolean;
};

export function usage(message: string): ServerError {
	return new ServerError('USAGE', `${message}; see bumail --help`);
}

/** `a, b or c`. */
function oneOf(words: readonly string[]): string {
	return words.length < 2
		? (words[0] ?? '')
		: `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
}

/** The options read, wherever they stand. */
export interface Options {
	config: string | undefined;
	passwordStdin: boolean;
	passwordFile: string | undefined;
	purge: boolean;
	selector: string | undefined;
	replace: boolean;
}

/**
 * A command word as a message names it: as given when it reads like one
 * — lowercase letters and hyphens, 20 at most — and `…` otherwise, so a
 * password typed where a command goes is not repeated.
 */
export function word(text: string): string {
	return /^[a-z][a-z-]{0,19}$/.test(text) ? text : '…';
}

/** Whether `word` is a noun of the directory commands. */
export function isNoun(word: string): word is Noun {
	return Object.hasOwn(VERBS, word);
}

/** `bumail <noun> <verb> <operands>`, checked against what the verb takes. */
export function resolveManage(
	noun: Noun,
	rest: readonly string[],
	options: Options,
): ManageArgs {
	const verbs = VERBS[noun];
	const [verb, ...operands] = rest;
	if (verb === undefined) {
		throw usage(`${noun} needs a command: ${oneOf(Object.keys(verbs))}`);
	}
	const spec = Object.hasOwn(verbs, verb) ? verbs[verb] : undefined;
	if (spec === undefined) {
		throw usage(
			`unknown command ${noun} ${word(verb)}; ${noun} takes ${oneOf(Object.keys(verbs))}`,
		);
	}
	const name = `${noun} ${verb}`;
	if (operands.length < spec.min || operands.length > spec.max) {
		throw usage(
			spec.password === true
				? `${name} takes ${spec.operands}: a password is never taken from the command line`
				: `${name} takes ${spec.operands}`,
		);
	}
	refuseOptions(name, options, spec);
	if (options.passwordStdin && options.passwordFile !== undefined) {
		throw usage(
			'--password-stdin and --password-file are both given; give one',
		);
	}
	return {
		kind: 'manage',
		noun,
		verb,
		operands,
		config: options.config,
		password: spec.password !== true ? undefined : passwordSource(options),
		purge: options.purge,
		selector: options.selector,
		replace: options.replace,
	};
}

function passwordSource(options: Options): PasswordSource {
	if (options.passwordStdin) return { from: 'stdin' };
	if (options.passwordFile !== undefined) {
		return { from: 'file', file: options.passwordFile };
	}
	return { from: 'prompt' };
}

/** Refuses an option the command does not take. */
export function refuseOptions(
	name: string,
	options: Options,
	spec: Partial<VerbSpec>,
): void {
	if (spec.password !== true) {
		if (options.passwordStdin) throw usage(`${name} takes no --password-stdin`);
		if (options.passwordFile !== undefined) {
			throw usage(`${name} takes no --password-file`);
		}
	}
	if (options.purge && spec.purge !== true) {
		throw usage(`${name} takes no --purge`);
	}
	if (spec.key !== true) {
		if (options.selector !== undefined) {
			throw usage(`${name} takes no --selector`);
		}
		if (options.replace) throw usage(`${name} takes no --replace`);
	}
}
