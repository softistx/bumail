import { afterEach, describe, expect, test } from 'bun:test';
import { SmtpError } from '../errors';
import type { SmtpServerOptions, TlsOptions } from './options';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const tls = {
	key: await fixture('localhost.key').text(),
	cert: await fixture('localhost.crt').text(),
};
const proxied = { proxyProtocol: { trusted: ['127.0.0.1'] } };

const servers: SmtpServer[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function server(overrides: Partial<SmtpServerOptions>): SmtpServer {
	const one = createSmtpServer(
		mxOptions({ tls, implicitTls: true, ...overrides }),
	);
	servers.push(one);
	return one;
}

/** What `listen` rejects with, or `undefined` once it bound. */
async function failure(one: SmtpServer): Promise<unknown> {
	try {
		await one.listen({ port: 0, hostname: '127.0.0.1' });
		return undefined;
	} catch (error) {
		return error;
	}
}

describe('listen, called twice at the same moment', () => {
	test.each([
		['with proxyProtocol', proxied],
		['without', {}],
	])(
		'%s: one binds, the other throws ALREADY_LISTENING',
		async (_, overrides) => {
			const one = server(overrides);
			const answers = await Promise.allSettled([
				one.listen({ port: 0, hostname: '127.0.0.1' }),
				one.listen({ port: 0, hostname: '127.0.0.1' }),
			]);
			expect(answers.map((answer) => answer.status).sort()).toEqual([
				'fulfilled',
				'rejected',
			]);
			const refused = answers.find((answer) => answer.status === 'rejected');
			expect(refused?.reason).toBeInstanceOf(SmtpError);
			expect(refused?.reason).toMatchObject({ code: 'ALREADY_LISTENING' });
			await expect(
				one.listen({ port: 0, hostname: '127.0.0.1' }),
			).rejects.toThrow(/already listening on 127\.0\.0\.1:/);
		},
	);
});

describe('a key or certificate listen cannot use', () => {
	const cases: [string, TlsOptions][] = [
		['a key that is not PEM', { key: 'not a key', cert: tls.cert }],
		['a certificate that is not PEM', { key: tls.key, cert: 'not a cert' }],
		[
			'a key file that does not exist',
			{ key: Bun.file('/nonexistent/bumail.key'), cert: tls.cert },
		],
	];

	test.each(cases)(
		'%s: the same SmtpError with proxyProtocol or without, the reason as its cause',
		async (_, bad) => {
			const plain = await failure(server({ tls: bad }));
			const behind = await failure(server({ tls: bad, ...proxied }));
			for (const error of [plain, behind]) {
				expect(error).toBeInstanceOf(SmtpError);
				expect((error as SmtpError).code).toBe('INVALID_OPTION');
				expect((error as SmtpError).message).toStartWith(
					'listen(): tls: { key, cert } cannot be used: ',
				);
				expect((error as Error).cause).toBeInstanceOf(Error);
			}
			expect((behind as Error).message).toBe((plain as Error).message);
		},
	);

	test('a failed listen leaves the server free to listen again', async () => {
		const one = server({ tls: { key: 'not a key', cert: tls.cert } });
		expect(await failure(one)).toBeInstanceOf(SmtpError);
		expect(await failure(one)).toBeInstanceOf(SmtpError);
	});
});
