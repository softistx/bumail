import { ServerError } from '../errors';
import type { Acme } from './acme';
import {
	bindOf,
	createListener,
	enabled,
	LISTENERS,
	type Listener,
	type Resources,
} from './listeners';
import type { Listening, ServeOptions } from './serve';

/** The listeners bound so far. */
export interface Bound {
	readonly started: Listener[];
	readonly listening: Listening[];
}

/** Bun's reason for a bind that failed, with its code when the message leaves it out. */
function bindReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === 'string' && !message.includes(code)
		? `${message}: ${code}`
		: message;
}

/**
 * Binds each listener of `resources` that is enabled, not bound yet and
 * accepted by `only`, adding it to `bound`. On a failure it throws
 * `UNAVAILABLE`, leaving `bound` for the caller to stop.
 */
export async function bindListeners(
	resources: Resources,
	options: ServeOptions,
	bound: Bound,
	only: (name: Listener['name']) => boolean = () => true,
): Promise<void> {
	const { config } = resources;
	for (const name of LISTENERS) {
		if (!enabled(name, config) || !only(name)) continue;
		if (bound.started.some((listener) => listener.name === name)) continue;
		const configured = config.ports[name];
		const port = options.port?.(name, configured) ?? configured;
		const listener = createListener(name, resources);
		try {
			const address = await listener.server.listen({
				port,
				hostname: bindOf(name, config),
			});
			resources.up.add(name);
			bound.listening.push({ name, ...address });
		} catch (error) {
			throw new ServerError(
				'UNAVAILABLE',
				`${name} cannot listen on ${bindOf(name, config)}:${port} (${bindReason(error)})`,
			);
		}
		bound.started.push(listener);
		if (listener.kind === 'imap') resources.imaps.push(listener.server);
	}
}

/**
 * Binds every listener. With `first` — an ACME server that has no
 * certificate stored — port 80 and the health check come first, then
 * `first` obtains the certificate (`resources.tls` takes it), and only
 * then do the TLS listeners bind: none can be made without a pair, and
 * the health check says `tls: down` meanwhile.
 */
export async function bindAll(
	resources: Resources,
	options: ServeOptions,
	bound: Bound,
	first: Acme | undefined,
): Promise<void> {
	if (first === undefined) {
		await bindListeners(resources, options, bound);
		return;
	}
	await bindListeners(
		resources,
		options,
		bound,
		(name) => name === 'http' || name === 'health',
	);
	resources.tls = await first.first(
		options.signal ?? new AbortController().signal,
	);
	await bindListeners(resources, options, bound);
}
