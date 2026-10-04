/**
 * A fake ACME server behind an injected `fetch`, for the client's unit
 * specs: a directory, nonces, one account, orders whose authorizations
 * turn `valid` once their `http-01` challenge is answered, finalize, and
 * a certificate. Every request is recorded with its protected header and
 * payload decoded, and any route can be replaced by a handler of the
 * spec's own.
 */
import type { AcmeFetch } from './types';

export const BASE = 'https://ca.test';
export const PROBLEM = 'urn:ietf:params:acme:error:';

/** A request as the fake saw it. */
export interface Recorded {
	method: string;
	url: string;
	path: string;
	headers: Headers;
	/** The JWS's protected header, decoded: POSTs only. */
	header?: Record<string, unknown>;
	/** The payload, decoded: `''` for a POST-as-GET. */
	payload?: unknown;
}

export type Handler = (
	request: Recorded,
	ca: FakeCa,
) => Response | Promise<Response>;

/** A PEM certificate the fake hands out: not a real one, only its shape. */
export const FAKE_CHAIN = `-----BEGIN CERTIFICATE-----\n${'QUJD'.repeat(16)}\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n${'REVG'.repeat(16)}\n-----END CERTIFICATE-----\n`;

export class FakeCa {
	readonly requests: Recorded[] = [];
	/** Routes replaced by the spec, by method and path: `'POST /authz/0'`. */
	readonly routes = new Map<string, Handler>();
	/** The names of the current order; each gets an authorization and a token. */
	names: string[] = [];
	/** Authorization states, by index. */
	authorizations: string[] = [];
	orderStatus = 'pending';
	/** What `newOrder` offers as challenges, by type. */
	challengeTypes = ['http-01', 'dns-01'];
	#nonce = 0;

	readonly fetch: AcmeFetch = async (input, init) => {
		const url = new URL(input);
		const method = init.method ?? 'GET';
		const recorded: Recorded = {
			method,
			url: input,
			path: url.pathname,
			headers: new Headers(init.headers as HeadersInit),
		};
		if (method === 'POST') {
			const jws = JSON.parse(String(init.body)) as Record<string, string>;
			recorded.header = JSON.parse(
				Buffer.from(jws['protected'] ?? '', 'base64url').toString(),
			);
			const payload = Buffer.from(jws['payload'] ?? '', 'base64url').toString();
			recorded.payload = payload === '' ? '' : JSON.parse(payload);
		}
		this.requests.push(recorded);
		const handler =
			this.routes.get(`${method} ${url.pathname}`) ?? this.#route(recorded);
		return await handler(recorded, this);
	};

	/** A fresh nonce. */
	nonce(): string {
		this.#nonce++;
		return `nonce${this.#nonce}`;
	}

	/** A JSON answer with a fresh `Replay-Nonce`. */
	json(
		body: unknown,
		status = 200,
		headers: Record<string, string> = {},
	): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: {
				'content-type': 'application/json',
				'replay-nonce': this.nonce(),
				...headers,
			},
		});
	}

	/** A problem document, with a fresh `Replay-Nonce`. */
	problem(
		type: string,
		detail: string,
		status = 400,
		headers: Record<string, string> = {},
		extra: Record<string, unknown> = {},
	): Response {
		return new Response(
			JSON.stringify({ type: `${PROBLEM}${type}`, detail, status, ...extra }),
			{
				status,
				headers: {
					'content-type': 'application/problem+json',
					'replay-nonce': this.nonce(),
					...headers,
				},
			},
		);
	}

	/** The requests to `path`, in order. */
	to(path: string): Recorded[] {
		return this.requests.filter((request) => request.path === path);
	}

	order(): Record<string, unknown> {
		return {
			status: this.orderStatus,
			identifiers: this.names.map((value) => ({ type: 'dns', value })),
			authorizations: this.names.map((_, i) => `${BASE}/authz/${i}`),
			finalize: `${BASE}/finalize/1`,
			...(this.orderStatus === 'valid'
				? { certificate: `${BASE}/cert/1` }
				: {}),
		};
	}

	authorization(i: number): Record<string, unknown> {
		const status = this.authorizations[i] ?? 'pending';
		return {
			status,
			identifier: { type: 'dns', value: this.names[i] },
			challenges: this.challengeTypes.map((type) => ({
				type,
				url: `${BASE}/chall/${i}/${type}`,
				status: status === 'valid' ? 'valid' : 'pending',
				token: `token${i}${type.replace('-', '')}`,
			})),
		};
	}

	#route(request: Recorded): Handler {
		const { method, path } = request;
		if (method === 'GET' && path === '/dir') {
			return (_, ca) =>
				ca.json({
					newNonce: `${BASE}/nonce`,
					newAccount: `${BASE}/account`,
					newOrder: `${BASE}/order`,
					revokeCert: `${BASE}/revoke`,
					keyChange: `${BASE}/key-change`,
					meta: { termsOfService: `${BASE}/terms`, ignored: 1 },
				});
		}
		if (method === 'HEAD' && path === '/nonce') {
			return (_, ca) =>
				new Response(null, { headers: { 'replay-nonce': ca.nonce() } });
		}
		if (method !== 'POST') {
			return () => new Response('Not found', { status: 404 });
		}
		if (path === '/account') {
			return (_, ca) =>
				ca.json({ status: 'valid' }, 201, { location: `${BASE}/acct/1` });
		}
		if (path === '/order') {
			return (req, ca) => {
				const identifiers = (
					req.payload as { identifiers: { value: string }[] }
				).identifiers;
				ca.names = identifiers.map((identifier) => identifier.value);
				ca.authorizations = ca.names.map(() => 'pending');
				ca.orderStatus = 'pending';
				return ca.json(ca.order(), 201, { location: `${BASE}/order/1` });
			};
		}
		if (path === '/order/1') return (_, ca) => ca.json(ca.order());
		const authz = /^\/authz\/(\d+)$/.exec(path);
		if (authz) return (_, ca) => ca.json(ca.authorization(Number(authz[1])));
		const challenge = /^\/chall\/(\d+)\/([\w-]+)$/.exec(path);
		if (challenge) {
			return (_, ca) => {
				const i = Number(challenge[1]);
				ca.authorizations[i] = 'valid';
				if (ca.authorizations.every((status) => status === 'valid')) {
					ca.orderStatus = 'ready';
				}
				return ca.json({
					type: challenge[2],
					url: request.url,
					status: 'processing',
					token: `token${i}`,
				});
			};
		}
		if (path === '/finalize/1') {
			return (_, ca) => {
				if (ca.orderStatus !== 'ready') {
					return ca.problem('orderNotReady', 'the order is not ready', 403);
				}
				ca.orderStatus = 'valid';
				return ca.json(ca.order());
			};
		}
		if (path === '/cert/1') {
			return (_, ca) =>
				new Response(FAKE_CHAIN, {
					headers: {
						'content-type': 'application/pem-certificate-chain',
						'replay-nonce': ca.nonce(),
					},
				});
		}
		return (_, ca) => ca.problem('malformed', `no route ${path}`, 404);
	}
}
