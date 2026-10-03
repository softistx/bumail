import { invalid } from '../../errors';
import type { QueueOptions, Route, Smarthost } from '../options';
import { numberOf } from './numbers';
import { checkTls } from './sessions';

/**
 * A smarthost `sendMail` will take, checked now rather than at each
 * delivery: a host, a port, a TLS mode, and credentials only over TLS
 * whose certificate is checked — `sendMail`'s own rule
 * (`@bumail/smtp`'s `client/settings.ts`), with no way out for a test.
 */
function checkRoute(name: string, route: Route): void {
	if (route === 'mx') return;
	const smarthost = route as Smarthost | undefined;
	const host = smarthost?.host;
	if (typeof host !== 'string' || !/^[^\s/]+$/.test(host)) {
		throw invalid(`${name} must be 'mx' or a smarthost with a host`);
	}
	const { port, secure, tls, auth } = smarthost as Smarthost;
	numberOf(`${name}.port`, port, 25, 1, 65535);
	if (secure !== undefined && typeof secure !== 'boolean') {
		throw invalid(`${name}.secure must be true or false, not ${secure}`);
	}
	checkTls(`${name}.tls`, tls);
	if (tls === 'none' && secure) {
		throw invalid(
			`${name}.secure is TLS from the first byte: it cannot go with tls: 'none'`,
		);
	}
	if (auth === undefined) return;
	if (typeof auth?.username !== 'string' || auth.username === '') {
		throw invalid(`${name}.auth.username must be a non-empty string`);
	}
	if (typeof auth.password !== 'string' || auth.password === '') {
		throw invalid(`${name}.auth.password must be a non-empty string`);
	}
	const { mechanism } = auth;
	if (
		mechanism !== undefined &&
		mechanism !== 'PLAIN' &&
		mechanism !== 'LOGIN'
	) {
		throw invalid(
			`${name}.auth.mechanism must be 'PLAIN' or 'LOGIN', not ${mechanism}`,
		);
	}
	if (tls !== undefined && tls !== 'required') {
		throw invalid(
			`${name}.auth needs tls: 'required', the default with auth: with tls: '${tls}' the password would go to a server whose certificate is not checked`,
		);
	}
}

export function checkRoutes(options: QueueOptions): void {
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
