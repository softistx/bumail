import { expect, test } from 'bun:test';
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
