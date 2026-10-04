import {
	createQueue,
	type Queue,
	type Route,
	type Sender,
	type Smarthost,
} from '@bumail/queue';
import type { MxResolver } from '@bumail/smtp/client';
import type {
	RouteConfig,
	ServerConfig,
	SmarthostConfig,
} from '../../config/types';
import type { Log } from '../log';
import { type LocalContext, localFirst } from './local';

export { type OpenedQueueStore, openQueueStore } from './store';

/** What `serve` takes for the queue, for specs: where MX hosts listen, a CA, how often it looks. */
export interface OutboundOptions {
	/** The port of MX hosts. Default 25. */
	readonly mxPort?: number;
	/** Certificates a smarthost or a route's host may present, besides the system's, PEM. */
	readonly ca?: string;
	/** Milliseconds between the queue's looks for due items. Default 5000. */
	readonly pollInterval?: number;
	/** What delivers to another server. Default `sendMail` of `@bumail/smtp/client`. */
	readonly send?: Sender;
}

/** Bytes a message may grow by between submission and the queue: its DKIM signature, at most. */
const SIGNATURE_ROOM = 64 * 1024;

function smarthostRoute(
	smarthost: SmarthostConfig,
	ca: string | undefined,
): Smarthost {
	const { host, port, secure, tls, username, password } = smarthost;
	return {
		host,
		port,
		secure,
		tls,
		...(username === undefined
			? {}
			: { auth: { username, password: password ?? '' } }),
		...(ca === undefined ? {} : { ca }),
	};
}

function routeOf(
	route: RouteConfig,
	smarthost: Smarthost | undefined,
	ca: string | undefined,
): Route {
	if (route === 'mx') return 'mx';
	if (route === 'smarthost') {
		if (smarthost === undefined) throw new Error('unreachable: checked');
		return smarthost;
	}
	return { ...route, ...(ca === undefined ? {} : { ca }) };
}

/**
 * The outbound queue on `store`: by MX, or through `[smarthost]`, with
 * `[routes]` per domain; mail for a hosted domain — a DSN back to a local
 * sender above all — straight to the store. Each outcome is logged. Not
 * started.
 */
export function createOutbound(
	config: ServerConfig,
	store: Parameters<typeof createQueue>[0]['store'],
	ctx: LocalContext & {
		readonly resolver: MxResolver;
		readonly log: Log;
		describe(error: unknown): string;
	},
	options: OutboundOptions = {},
): Queue {
	const { ca } = options;
	const smarthost =
		config.smarthost === undefined
			? undefined
			: smarthostRoute(config.smarthost, ca);
	const routes: Record<string, Route> = {};
	for (const [domain, route] of Object.entries(config.routes)) {
		routes[domain] = routeOf(route, smarthost, ca);
	}
	const queue = createQueue({
		store,
		hostname: config.hostname,
		route: smarthost ?? 'mx',
		routes,
		resolver: ctx.resolver,
		...(options.mxPort === undefined ? {} : { mxPort: options.mxPort }),
		...(options.pollInterval === undefined
			? {}
			: { pollInterval: options.pollInterval }),
		limits: {
			maxMessageSize: config.submission.maxMessageSize + SIGNATURE_ROOM,
			maxRecipients: config.submission.maxRecipients,
		},
		send: localFirst(ctx, options.send),
	});
	logOutcomes(queue, ctx.log, (error) => ctx.describe(error));
	return queue;
}

/** One line per outcome: `outbound: <id> …`. */
function logOutcomes(
	queue: Queue,
	log: Log,
	describe: (error: unknown) => string,
): void {
	const said = (
		reply: { code?: number; status?: string; text: string } | undefined,
	) =>
		reply === undefined
			? ''
			: `: ${[reply.code, reply.status, reply.text].filter((p) => p !== undefined).join(' ')}`;
	queue.on('delivered', ({ id, from, recipient, reply }) => {
		log(
			`outbound: ${id} <${from}> delivered to ${recipient}${reply?.host === undefined ? '' : ` by ${reply.host}`}`,
		);
	});
	queue.on('deferred', ({ id, recipient, reply, nextAttemptAt }) => {
		log(
			`outbound: ${id} to ${recipient} deferred until ${new Date(nextAttemptAt).toISOString()}${said(reply)}`,
		);
	});
	queue.on('failed', ({ id, recipient, reply }) => {
		log(`outbound: ${id} to ${recipient} failed${said(reply)}`);
	});
	queue.on('dsn', ({ id, kind, of, to }) => {
		log(`outbound: ${of}: a ${kind} DSN to <${to}> queued as ${id}`);
	});
	queue.on('error', ({ error, id }) => {
		log(
			`outbound: error${id === undefined ? '' : ` on ${id}`}: ${describe(error)}`,
		);
	});
}
