import { type Fixture, PASSWORD, startServer } from '../serve.fixtures';

export { PASSWORD };

/** A proxy on loopback, trusted by the server: it connects from 127.0.0.1. */
export const PROXY_CONFIG = `
[ports]
https = 8081
[jmap]
mode = "proxy"
origin = "https://jmap.example.org"
trusted = ["127.0.0.1", "::1"]
`;

/** `Authorization: Basic …` for alice, with `password`. */
export function basic(password: string, user = 'alice@example.com'): string {
	return `Basic ${btoa(`${user}:${password}`)}`;
}

/** The server for `extra`, and a `get` of its session at `/.well-known/jmap`. */
export async function startJmap(extra = ''): Promise<
	Fixture & {
		/** The session, from the JMAP listener, over `https:` or `http:` as it is. */
		session(headers: Record<string, string>): Promise<Response>;
	}
> {
	const fixture = await startServer(extra);
	const secure = !extra.includes('mode = "proxy"');
	const base = `${secure ? 'https' : 'http'}://127.0.0.1:${fixture.port('https')}`;
	return {
		...fixture,
		session: (headers) =>
			fetch(`${base}/.well-known/jmap`, {
				headers,
				tls: { rejectUnauthorized: false },
			}),
	};
}
