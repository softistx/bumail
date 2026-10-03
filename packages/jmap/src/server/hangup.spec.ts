import { afterEach, expect, spyOn, test } from 'bun:test';
import { connect } from 'node:net';
import { alxia } from '@alxia/core';
import { MemoryMailStore } from '@bumail/store';
import { jmap } from './jmap';

/** Sends the head and part of a body to `path`, then hangs up. */
function hangUp(port: number, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, '127.0.0.1', () => {
			socket.write(
				`POST ${path} HTTP/1.1\r\nHost: mail\r\nAuthorization: Bearer t\r\nContent-Length: 100000\r\n\r\n${'x'.repeat(1000)}`,
			);
			setTimeout(() => {
				socket.destroy();
				resolve();
			}, 100);
		});
		socket.on('error', reject);
	});
}

let stop = () => {};
afterEach(() => stop());

test('a client that hangs up mid-body is a bodyless 499, with no onError and nothing logged', async () => {
	const store = new MemoryMailStore();
	const { id } = await store.createAccount('alice');
	const errors: unknown[] = [];
	const responses: { status: number; body: string }[] = [];
	const log = spyOn(console, 'error');
	const app = alxia()
		.onResponse(async (response) => {
			responses.push({
				status: response.status,
				body: await response.clone().text(),
			});
		})
		.use(
			jmap({
				store,
				origin: 'http://mail',
				authenticate: () => id,
				onError: (error) => errors.push(error),
			}),
		);
	const server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
	stop = () => {
		log.mockRestore();
		server.stop(true);
	};
	for (const path of ['/jmap/api', `/jmap/upload/${id}`]) {
		await hangUp(server.port ?? 0, path);
		await Bun.sleep(100);
	}
	expect(responses).toEqual([
		{ status: 499, body: '' },
		{ status: 499, body: '' },
	]);
	expect(errors).toEqual([]);
	expect(log).not.toHaveBeenCalled();
});
