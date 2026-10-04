import { connect, createServer, type Socket } from 'node:net';

/**
 * A TCP proxy for specs, as a Traefik TCP router with `proxyProtocol`:
 * each client it accepts gets a connection to the server at `target`,
 * which is sent `header` first, then everything the client sends, and
 * the server's answers go back. With `coalesce`, it waits for the client's
 * first bytes — a ClientHello, on implicit TLS — and sends them in the
 * same write as the header, as a proxy often does.
 */
export async function front(
	target: number,
	header: Uint8Array,
	{ coalesce = false } = {},
): Promise<{ port: number; close(): void }> {
	const sockets = new Set<Socket>();
	const server = createServer((client) => {
		sockets.add(client);
		const open = (first?: Buffer) => {
			const upstream = connect(target, '127.0.0.1', () => {
				upstream.write(first ? Buffer.concat([header, first]) : header);
				client.pipe(upstream);
				upstream.pipe(client);
			});
			sockets.add(upstream);
			upstream.on('error', () => client.destroy());
			upstream.on('close', () => client.end());
			client.on('close', () => upstream.destroy());
		};
		client.on('error', () => {});
		if (!coalesce) return open();
		client.once('data', (first: Buffer) => {
			// Until the pipe: what the client sends next waits.
			client.pause();
			open(first);
		});
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const address = server.address();
	return {
		port: typeof address === 'object' && address ? address.port : 0,
		close() {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}
