import { describe, expect, test } from 'bun:test';
import { connect as tlsConnect } from 'node:tls';
import { selfSigned } from '../../config/certificates.fixtures';
import { httpListener } from './listener';

test('stop() without force lets a request under way finish, and takes no new one', async () => {
	const listener = httpListener({
		fetch: async () => {
			await Bun.sleep(300);
			return new Response('done');
		},
	});
	const { port } = await listener.listen({ port: 0, hostname: '127.0.0.1' });
	const answer = fetch(`http://127.0.0.1:${port}/`);
	await Bun.sleep(100);
	expect(listener.pending).toBe(1);
	listener.stop(false);
	expect(await (await answer).text()).toBe('done');
	expect(
		await fetch(`http://127.0.0.1:${port}/`, { keepalive: false }).then(
			() => 'served',
			() => 'refused',
		),
	).toBe('refused');
	listener.stop(true);
});

describe('setTls', () => {
	const cn = (port: number) =>
		new Promise<string | undefined>((done, fail) => {
			const socket = tlsConnect(
				{ host: '127.0.0.1', port, rejectUnauthorized: false },
				() => {
					done([socket.getPeerCertificate().subject?.CN].flat()[0]);
					socket.destroy();
				},
			);
			socket.on('error', fail);
		});

	test('serves the renewed pair from the next connection, and lets a request under way finish', async () => {
		const first = await selfSigned(['first.example']);
		const renewed = await selfSigned(['renewed.example']);
		const listener = httpListener({
			tls: first,
			fetch: async (request) => {
				if (new URL(request.url).pathname === '/slow') await Bun.sleep(400);
				return new Response('answered');
			},
		});
		const { port } = await listener.listen({ port: 0, hostname: '127.0.0.1' });
		const slow = fetch(`https://127.0.0.1:${port}/slow`, {
			tls: { rejectUnauthorized: false },
		}).then((response) => response.text());
		await Bun.sleep(100);
		expect(await cn(port)).toBe('first.example');
		await listener.setTls?.(renewed);
		expect(listener.pending).toBe(1);
		expect(await cn(port)).toBe('renewed.example');
		expect(await slow).toBe('answered');
		const again = await fetch(`https://127.0.0.1:${port}/`, {
			tls: { rejectUnauthorized: false },
		});
		expect(await again.text()).toBe('answered');
		await Bun.sleep(50);
		expect(listener.pending).toBe(0);
		listener.stop(true);
	});

	test('a pair that cannot be used leaves the server as it was', async () => {
		const first = await selfSigned(['first.example']);
		const listener = httpListener({
			tls: first,
			fetch: () => new Response('ok'),
		});
		const { port } = await listener.listen({ port: 0, hostname: '127.0.0.1' });
		await expect(
			listener.setTls?.({ cert: 'nope', key: first.key }) ?? Promise.resolve(),
		).rejects.toThrow();
		expect(await cn(port)).toBe('first.example');
		listener.stop(true);
	});

	test('stop() stops the replaced server too', async () => {
		const first = await selfSigned(['first.example']);
		const renewed = await selfSigned(['renewed.example']);
		const listener = httpListener({
			tls: first,
			fetch: async () => {
				await Bun.sleep(5000);
				return new Response('late');
			},
		});
		const { port } = await listener.listen({ port: 0, hostname: '127.0.0.1' });
		const pending = fetch(`https://127.0.0.1:${port}/`, {
			tls: { rejectUnauthorized: false },
		}).catch(() => 'cut');
		await Bun.sleep(100);
		await listener.setTls?.(renewed);
		listener.stop(true);
		expect(await pending).toBe('cut');
		expect(listener.pending).toBe(0);
	});

	test('swappable: false binds alone, with no setTls: another bind of the port fails', async () => {
		const first = await selfSigned(['first.example']);
		const listener = httpListener({
			tls: first,
			swappable: false,
			fetch: () => new Response('ok'),
		});
		const { port } = await listener.listen({ port: 0, hostname: '127.0.0.1' });
		expect(listener.setTls).toBeUndefined();
		expect(() =>
			Bun.serve({
				port,
				hostname: '127.0.0.1',
				reusePort: true,
				fetch: () => new Response('intruder'),
			}),
		).toThrow();
		listener.stop(true);
	});

	test('is there only on a listener that has TLS', () => {
		expect(
			httpListener({ fetch: () => new Response('') }).setTls,
		).toBeUndefined();
	});
});
