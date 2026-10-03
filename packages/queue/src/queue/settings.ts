import { sendMail } from '@bumail/smtp/client';
import { invalid } from '../errors';
import { checkAddress } from './envelope';
import type { QueueOptions, Route, Sender, Smarthost } from './options';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface RetrySettings {
	readonly first: number;
	readonly factor: number;
	readonly max: number;
	readonly jitter: number;
	readonly giveUpAfter: number;
}

export interface LimitSettings {
	readonly maxMessageSize: number;
	readonly maxRecipients: number;
	readonly maxItems: number | undefined;
	readonly maxReplyText: number;
	readonly maxDsnReturn: number;
}

export interface DsnSettings {
	readonly from: string;
	readonly delayAfter: number | false;
	readonly returnContent: 'headers' | 'full';
}

/** Every option checked, with its default. */
export interface Settings {
	readonly options: QueueOptions;
	readonly hostname: string;
	/** The routes by domain, in lowercase. */
	readonly routes: ReadonlyMap<string, Route>;
	readonly retry: RetrySettings;
	readonly limits: LimitSettings;
	readonly dsn: DsnSettings;
	readonly concurrency: number;
	readonly perDomain: number;
	readonly leaseMs: number;
	readonly pollInterval: number;
	readonly owner: string;
	readonly now: () => number;
	readonly send: Sender;
	readonly random: () => number;
}

/** A number in `[min, max]`, integer when asked, or its default. */
function numberOf(
	name: string,
	value: unknown,
	fallback: number,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
	integer = true,
): number {
	if (value === undefined) return fallback;
	const ok =
		typeof value === 'number' &&
		(integer ? Number.isInteger(value) : Number.isFinite(value)) &&
		value >= min &&
		value <= max;
	if (!ok) {
		const kind = integer ? 'an integer' : 'a number';
		throw invalid(
			`${name} must be ${kind} from ${min} to ${max}, not ${value}`,
		);
	}
	return value as number;
}

const HOSTNAME =
	/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

function checkRoute(name: string, route: Route): void {
	if (route === 'mx') return;
	const host = (route as Smarthost | undefined)?.host;
	if (typeof host !== 'string' || !/^[^\s/]+$/.test(host)) {
		throw invalid(`${name} must be 'mx' or a smarthost with a host`);
	}
}

function checkRoutes(options: QueueOptions): void {
	checkRoute('route', options.route ?? 'mx');
	const routes = Object.entries(options.routes ?? {});
	for (const [domain, route] of routes)
		checkRoute(`routes["${domain}"]`, route);
	const usesMx =
		(options.route ?? 'mx') === 'mx' || routes.some(([, r]) => r === 'mx');
	if (usesMx && typeof options.resolver?.mx !== 'function') {
		throw invalid(
			"The 'mx' route needs a resolver, such as @bumail/dns's nodeResolver()",
		);
	}
}

function retryOf(options: QueueOptions): RetrySettings {
	const r = options.retry ?? {};
	const first = numberOf('retry.first', r.first, 30 * MINUTE, 1);
	return {
		first,
		factor: numberOf('retry.factor', r.factor, 2, 1, 100, false),
		max: numberOf('retry.max', r.max, Math.max(first, 4 * HOUR), first),
		jitter: numberOf('retry.jitter', r.jitter, 0.1, 0, 1, false),
		giveUpAfter: numberOf('retry.giveUpAfter', r.giveUpAfter, 120 * HOUR, 0),
	};
}

function limitsOf(options: QueueOptions): LimitSettings {
	const l = options.limits ?? {};
	return {
		maxMessageSize: numberOf(
			'limits.maxMessageSize',
			l.maxMessageSize,
			25 * 1024 * 1024,
			1,
		),
		maxRecipients: numberOf('limits.maxRecipients', l.maxRecipients, 100, 1),
		maxItems:
			l.maxItems === undefined
				? undefined
				: numberOf('limits.maxItems', l.maxItems, 0, 1),
		maxReplyText: numberOf('limits.maxReplyText', l.maxReplyText, 512, 64, 900),
		maxDsnReturn: numberOf('limits.maxDsnReturn', l.maxDsnReturn, 64 * 1024, 0),
	};
}

function dsnOf(options: QueueOptions, hostname: string): DsnSettings {
	const d = options.dsn ?? {};
	const from = checkAddress('dsn.from', d.from ?? `postmaster@${hostname}`);
	const delayAfter =
		d.delayAfter === false
			? false
			: numberOf('dsn.delayAfter', d.delayAfter, 4 * HOUR, 0);
	const returnContent = d.returnContent ?? 'headers';
	if (returnContent !== 'headers' && returnContent !== 'full') {
		throw invalid(
			`dsn.returnContent must be 'headers' or 'full', not ${returnContent}`,
		);
	}
	return { from, delayAfter, returnContent };
}

/** The options, checked, with their defaults; `INVALID` names the first wrong one. */
export function settingsOf(options: QueueOptions): Settings {
	if (typeof options !== 'object' || options === null) {
		throw invalid('createQueue() takes an options object');
	}
	if (typeof options.store?.claim !== 'function') {
		throw invalid('store must be a QueueStore, such as MemoryQueueStore');
	}
	const { hostname } = options;
	if (typeof hostname !== 'string' || !HOSTNAME.test(hostname)) {
		throw invalid(
			`hostname must be this server's public host name, not ${hostname}`,
		);
	}
	checkRoutes(options);
	const owner = options.owner ?? crypto.randomUUID();
	if (typeof owner !== 'string' || owner === '') {
		throw invalid('owner must be a non-empty string');
	}
	const clock = options.clock;
	return {
		options,
		hostname,
		routes: new Map(
			Object.entries(options.routes ?? {}).map(([d, r]) => [
				d.toLowerCase(),
				r,
			]),
		),
		retry: retryOf(options),
		limits: limitsOf(options),
		dsn: dsnOf(options, hostname),
		concurrency: numberOf('concurrency', options.concurrency, 20, 1),
		perDomain: numberOf('perDomain', options.perDomain, 2, 1),
		leaseMs: numberOf('leaseMs', options.leaseMs, 10 * MINUTE, 1000),
		pollInterval: numberOf('pollInterval', options.pollInterval, 5000, 1),
		owner,
		now: clock ? () => clock.now() : Date.now,
		send: options.send ?? sendMail,
		random: options.random ?? Math.random,
	};
}
