import type { MailStore } from '@bumail/store';
import { JmapError } from '../errors';
import type { JmapLimits, JmapOptions } from './options';

/** The longest delay `setTimeout` takes, in whole seconds: past 2^31 − 1 ms it fires after 1 ms. */
export const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000);

/** Every limit, with its default. */
export type Limits = { readonly [Key in keyof JmapLimits]-?: number };

/** The options with their defaults, checked once. */
export interface Settings {
	readonly options: JmapOptions;
	readonly store: MailStore;
	/** `https://mail.example.com`, without a trailing slash. */
	readonly origin: string;
	/** `/jmap`: where the API, download and upload routes are. */
	readonly basePath: string;
	readonly limits: Limits;
	readonly hookTimeout: number;
}

const MiB = 1024 * 1024;

/** Each limit's default, and its largest value. */
const BOUNDS: { readonly [Key in keyof Limits]: readonly [number, number] } = {
	maxSizeUpload: [25 * MiB, 2 ** 31],
	maxConcurrentUpload: [4, 1000],
	maxSizeRequest: [10_000_000, 2 ** 31],
	maxConcurrentRequests: [4, 1000],
	maxCallsInRequest: [16, 1000],
	maxObjectsInGet: [500, 100_000],
	maxObjectsInSet: [500, 100_000],
	maxJsonDepth: [64, 1000],
	maxJsonTokens: [100_000, 100_000_000],
	maxReferenceItems: [5000, 1_000_000],
	maxQueryScan: [10_000, 10_000_000],
	maxBodyValueBytes: [MiB, 2 ** 31],
	maxBodyValuesTotal: [16 * MiB, 2 ** 31],
	uploadQuota: [100 * MiB, 2 ** 40],
	uploadTtl: [3600, MAX_TIMER_SECONDS],
};

const invalid = (message: string) =>
	new JmapError('INVALID_OPTION', `jmap(): ${message}`);

function positive(
	name: string,
	value: unknown,
	fallback: number,
	max: number,
): number {
	if (value === undefined) return fallback;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
		throw invalid(`${name} must be a positive integer, not ${String(value)}`);
	}
	if (value > max)
		throw invalid(`${name} must be at most ${max}, not ${value}`);
	return value;
}

function limitsOf(given: JmapLimits | undefined): Limits {
	if (given !== undefined && (typeof given !== 'object' || given === null)) {
		throw invalid('limits must be an object');
	}
	const limits: Record<string, number> = {};
	for (const [name, [fallback, max]] of Object.entries(BOUNDS)) {
		const value = (given as Record<string, unknown> | undefined)?.[name];
		limits[name] = positive(`limits.${name}`, value, fallback, max);
	}
	for (const name of Object.keys(given ?? {})) {
		if (!(name in BOUNDS)) throw invalid(`limits.${name} is not a limit`);
	}
	return limits as Limits;
}

function originOf(value: unknown): string {
	let url: URL | undefined;
	try {
		url = typeof value === 'string' ? new URL(value) : undefined;
	} catch {
		url = undefined;
	}
	if (
		url === undefined ||
		(url.protocol !== 'https:' && url.protocol !== 'http:') ||
		url.origin !== String(value).replace(/\/$/, '')
	) {
		throw invalid(
			`origin must be an http: or https: origin, such as https://mail.example.com, not ${JSON.stringify(String(value)).slice(0, 100)}`,
		);
	}
	return url.origin;
}

function basePathOf(value: unknown): string {
	if (value === undefined) return '/jmap';
	if (typeof value !== 'string' || !/^(\/[A-Za-z0-9._~-]+)+$/.test(value)) {
		throw invalid(
			`basePath must be a path such as /jmap, with no trailing slash, not ${JSON.stringify(String(value)).slice(0, 100)}`,
		);
	}
	return value;
}

function checkStore(store: unknown): asserts store is MailStore {
	const methods = [
		'getAccount',
		'listMailboxes',
		'listAccountMessages',
		'mailboxChanges',
		'messageChanges',
		'readContent',
	];
	if (
		typeof store !== 'object' ||
		store === null ||
		methods.some(
			(name) => typeof (store as Record<string, unknown>)[name] !== 'function',
		)
	) {
		throw invalid('store must be a MailStore, such as new MemoryMailStore()');
	}
}

export function settingsOf(options: JmapOptions): Settings {
	if (typeof options !== 'object' || options === null) {
		throw invalid('the options must be an object');
	}
	checkStore(options.store);
	if (typeof options.authenticate !== 'function') {
		throw invalid('authenticate must be a function: it is how clients log in');
	}
	for (const hook of ['secure', 'onError'] as const) {
		if (options[hook] !== undefined && typeof options[hook] !== 'function') {
			throw invalid(`${hook} must be a function`);
		}
	}
	return {
		options,
		store: options.store,
		origin: originOf(options.origin),
		basePath: basePathOf(options.basePath),
		limits: limitsOf(options.limits),
		hookTimeout: positive(
			'hookTimeout',
			options.hookTimeout,
			30,
			MAX_TIMER_SECONDS,
		),
	};
}
