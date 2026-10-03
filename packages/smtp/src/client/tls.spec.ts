import { afterEach, describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { failure, startServer, stopServers, TLS } from './client.fixtures';
import { sendMail } from './send';

afterEach(stopServers);

const MESSAGE =
	'From: a@bar.com\r\nTo: b@foo.com\r\nSubject: hi\r\n\r\nhello\r\n';
const to = (port: number) => ({ host: '127.0.0.1', port });

describe('sendMail with TLS and AUTH, to this package’s own server', () => {
	test('opportunistic STARTTLS: encrypted, the self-signed certificate not checked (RFC 7435)', async () => {
		const { port, received } = await startServer();
		const result = await sendMail(MESSAGE, {
			...to(port),
			from: 'a@bar.com',
			to: 'b@foo.com',
		});
		expect(result.tls).toEqual({ verified: false });
		expect(received).toHaveLength(1);
	});

	test("tls: 'required' checks the certificate: trusted through ca, refused without", async () => {
		const { port } = await startServer();
		const options = {
			...to(port),
			from: 'a@bar.com',
			to: 'b@foo.com',
			tls: 'required' as const,
		};
		const ok = await sendMail(MESSAGE, { ...options, ca: TLS.cert });
		expect(ok.tls).toEqual({ verified: true });
		const error = await failure(sendMail(MESSAGE, options));
		expect(error.code).toBe('TLS_FAILED');
		expect(error.temporary).toBe(true);
		expect(error.message).toStartWith('TLS with 127.0.0.1 failed: ');
	});

	test("tls: 'required' fails when STARTTLS is not offered; 'none' never starts it", async () => {
		const { port } = await startServer({}, true);
		const error = await failure(
			sendMail(MESSAGE, {
				...to(port),
				from: 'a@bar.com',
				to: 'b@foo.com',
				tls: 'required',
			}),
		);
		expect(error.code).toBe('TLS_UNAVAILABLE');
		expect(error.message).toBe(
			"127.0.0.1 does not offer STARTTLS, and tls is 'required'",
		);
		const tls = await startServer();
		const clear = await sendMail(MESSAGE, {
			...to(tls.port),
			from: 'a@bar.com',
			to: 'b@foo.com',
			tls: 'none',
		});
		expect(clear.tls).toBe(false);
	});

	test('AUTH PLAIN and LOGIN after STARTTLS: a relayed message (RFC 4954)', async () => {
		const { port, received } = await startServer({ mode: 'submission' });
		for (const mechanism of ['PLAIN', 'LOGIN'] as const) {
			const result = await sendMail(MESSAGE, {
				...to(port),
				from: 'alice@foo.com',
				to: 'z@elsewhere.example',
				auth: { username: 'alice', password: 'secret', mechanism },
				ca: TLS.cert,
			});
			expect(result).toMatchObject({
				authenticated: true,
				tls: { verified: true },
			});
		}
		expect(received).toHaveLength(2);
		const error = await failure(
			sendMail(MESSAGE, {
				...to(port),
				from: 'alice@foo.com',
				to: 'z@elsewhere.example',
				auth: { username: 'alice', password: 'wrong' },
				ca: TLS.cert,
			}),
		);
		expect(error).toMatchObject({ code: 'REFUSED', temporary: false });
		expect(error.message).toBe(
			'127.0.0.1 refused AUTH PLAIN: 535 5.7.8 Authentication credentials invalid',
		);
	});

	test('implicit TLS (secure: true, RFC 8314)', async () => {
		const { port, received } = await startServer({
			mode: 'submission',
			implicitTls: true,
		});
		const result = await sendMail(MESSAGE, {
			...to(port),
			secure: true,
			from: 'alice@foo.com',
			to: 'b@foo.com',
			auth: { username: 'alice', password: 'secret' },
			ca: TLS.cert,
		});
		expect(result.tls).toEqual({ verified: true });
		expect(received).toHaveLength(1);
	});

	test('a certificate for another name is refused, whatever the CA (secure: true)', async () => {
		const { port } = await startServer({ implicitTls: true });
		const resolver = fixtureResolver({
			'foo.com': { mx: [{ exchange: 'mx.foo.com', priority: 10 }] },
			'mx.foo.com': { a: ['127.0.0.1'] },
		});
		const error = await failure(
			sendMail(MESSAGE, {
				domain: 'foo.com',
				resolver,
				port,
				secure: true,
				ca: TLS.cert,
				from: 'a@bar.com',
				to: 'b@foo.com',
			}),
		);
		expect(error).toMatchObject({ code: 'TLS_FAILED', temporary: true });
		expect(error.message).toBe(
			'TLS with mx.foo.com failed: ERR_TLS_CERT_ALTNAME_INVALID',
		);
	});
});
