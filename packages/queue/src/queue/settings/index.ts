import { sendMail } from '@bumail/smtp/client';
import { checkOwner } from '../../contract/checks';
import { invalid } from '../../errors';
import type { QueueOptions, Route, Sender } from '../options';
import { type DsnSettings, dsnOf } from './dsn';
import {
	type LimitSettings,
	limitsOf,
	type RetrySettings,
	retryOf,
} from './limits';
import { MAX_TIMER, MINUTE, numberOf } from './numbers';
import { checkRoutes } from './routes';
import { checkSessions } from './sessions';

export type { DsnSettings, LimitSettings, RetrySettings };

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

const HOSTNAME =
	/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

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
	checkSessions(options);
	const owner = checkOwner(options.owner ?? crypto.randomUUID());
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
		leaseMs: numberOf(
			'leaseMs',
			options.leaseMs,
			10 * MINUTE,
			1000,
			3 * MAX_TIMER,
		),
		pollInterval: numberOf(
			'pollInterval',
			options.pollInterval,
			5000,
			1,
			MAX_TIMER,
		),
		owner,
		now: clock ? () => clock.now() : Date.now,
		send: options.send ?? sendMail,
		random: options.random ?? Math.random,
	};
}
