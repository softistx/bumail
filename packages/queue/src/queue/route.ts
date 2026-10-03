import type { SendMailOptions } from '@bumail/smtp/client';
import type { Route } from './options';
import type { Settings } from './settings';

/** The route for a recipient domain: its own, else the default. */
export function routeOf(settings: Settings, domain: string): Route {
	return settings.routes.get(domain) ?? settings.options.route ?? 'mx';
}

/** The host an attempt goes to, as far as the route says: the smarthost, or nothing for MX. */
export function hostOf(route: Route): string | undefined {
	return route === 'mx' ? undefined : route.host;
}

/** What `sendMail` takes to send one domain's recipients of a message. */
export function sendOptionsOf(
	settings: Settings,
	domain: string,
	from: string,
	to: readonly string[],
): SendMailOptions {
	const { options, hostname } = settings;
	const common = {
		from,
		to,
		helo: hostname,
		...(options.timeouts ? { timeouts: options.timeouts } : {}),
		...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
	};
	const route = routeOf(settings, domain);
	if (route === 'mx') {
		const resolver = options.resolver;
		if (!resolver) throw new Error('unreachable: settings check the resolver');
		return {
			...common,
			domain,
			resolver,
			...(options.mxPort !== undefined ? { port: options.mxPort } : {}),
			...(options.mxTls ? { tls: options.mxTls } : {}),
		};
	}
	return {
		...common,
		host: route.host,
		...(route.port !== undefined ? { port: route.port } : {}),
		...(route.secure !== undefined ? { secure: route.secure } : {}),
		...(route.tls ? { tls: route.tls } : {}),
		...(route.auth ? { auth: route.auth } : {}),
		...(route.ca ? { ca: route.ca } : {}),
	};
}
