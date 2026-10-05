import type { MailStore } from '@bumail/store';
import type { ServerConfig } from '../../config/types';
import type { Directory } from '../../directory/directory';
import type { Log } from '../log';
import { type HttpListener, httpListener } from './listener';

/** Milliseconds the store has to answer a health check. */
export const STORE_TIMEOUT_MS = 3000;

/** Milliseconds a report is shared by the requests that follow it. */
export const CACHE_MS = 1000;

/** What the health check looks at. */
export interface HealthContext {
	readonly config: ServerConfig;
	readonly directory: Directory;
	readonly store: MailStore;
	/** The listeners to check, by name, as `ports` names them: the configured ones other than `health`. */
	readonly expected: readonly string[];
	/** The names of the listeners bound and not stopping. */
	readonly up: ReadonlySet<string>;
	/** With `tls.mode = "acme"`: whether a certificate is in use. */
	tls?(): 'up' | 'pending' | 'down';
	readonly log: Log;
}

/** The body of `/healthz`: each part, `up`, `down`, `ok` or `failed`; never an error's text. */
export interface HealthReport {
	readonly status: 'ok' | 'unavailable';
	readonly listeners: Record<string, 'up' | 'down'>;
	/** Only with `tls.mode = "acme"`: `pending` until the first certificate arrives, `down` past the end of the last one served. */
	readonly tls?: 'up' | 'pending' | 'down';
	readonly directory: 'ok' | 'failed';
	readonly store: 'ok' | 'failed';
}

/** One part answering: `ok`, or `failed` when it throws, or the store past `STORE_TIMEOUT_MS`. */
async function answers(ask: () => unknown): Promise<'ok' | 'failed'> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('timeout')), STORE_TIMEOUT_MS);
		});
		await Promise.race([Promise.resolve().then(ask), timeout]);
		return 'ok';
	} catch {
		return 'failed';
	} finally {
		clearTimeout(timer);
	}
}

/** The report: every listener bound, the directory and the store answering. */
export async function report(ctx: HealthContext): Promise<HealthReport> {
	const [directory, store] = await Promise.all([
		answers(() => ctx.directory.domains.has('health.invalid')),
		answers(() => ctx.store.findAccount('health@health.invalid')),
	]);
	// Read after the checks, which may take seconds: a listener that went
	// down meanwhile is reported down, never up from before.
	const listeners: Record<string, 'up' | 'down'> = {};
	for (const name of ctx.expected) {
		listeners[name] = ctx.up.has(name) ? 'up' : 'down';
	}
	const tls = ctx.tls?.();
	const healthy =
		(tls === undefined || tls === 'up') &&
		directory === 'ok' &&
		store === 'ok' &&
		Object.values(listeners).every((state) => state === 'up');
	return {
		status: healthy ? 'ok' : 'unavailable',
		listeners,
		...(tls === undefined ? {} : { tls }),
		directory,
		store,
	};
}

/** The parts of a report that are not well, for the log. */
function failing(health: HealthReport): string[] {
	const parts = Object.entries(health.listeners)
		.filter(([, state]) => state === 'down')
		.map(([name]) => name);
	if (health.tls === 'down' || health.tls === 'pending') parts.push('tls');
	if (health.directory === 'failed') parts.push('directory');
	if (health.store === 'failed') parts.push('store');
	return parts;
}

/**
 * `GET /healthz`: 200 with the report when every listener is up and the
 * directory and the store answer, else 503; any other path is 404, any
 * other method 405. One report is made at a time and shared for about
 * a second. The log says when it turns unhealthy, and when it is
 * well again, not at each look.
 */
export function createHealth(ctx: HealthContext): HttpListener {
	let healthy = true;
	let latest: { at: number; report: Promise<HealthReport> } | undefined;
	// One report in flight, shared by the requests that come while it is
	// made and for `CACHE_MS` after: a flood of looks costs one look.
	const current = () => {
		if (latest === undefined || Date.now() - latest.at > CACHE_MS) {
			latest = { at: Date.now(), report: report(ctx) };
		}
		return latest.report;
	};
	return httpListener({
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname !== '/healthz') {
				return new Response('not found', { status: 404 });
			}
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				return new Response('method not allowed', {
					status: 405,
					headers: { allow: 'GET, HEAD' },
				});
			}
			const health = await current();
			const ok = health.status === 'ok';
			if (ok !== healthy) {
				healthy = ok;
				ctx.log(
					ok
						? 'health: healthy again'
						: `health: unhealthy: ${failing(health).join(', ')}`,
				);
			}
			return Response.json(health, {
				status: ok ? 200 : 503,
				headers: { 'cache-control': 'no-store' },
			});
		},
	});
}
