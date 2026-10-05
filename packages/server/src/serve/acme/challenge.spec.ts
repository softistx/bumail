import { afterEach, describe, expect, test } from 'bun:test';
import { createChallenge } from './challenge';

const TOKEN = 'evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA';
const ANSWER = `${TOKEN}.nP1qzpXGymHBrUEepNY9HCsQk7K8KhOypzEt62jcerQ`;

let stop: (() => void) | undefined;
afterEach(() => stop?.());

/** The listener on a free port, a token set, and what it logged. */
async function listening() {
	const lines: string[] = [];
	const challenge = createChallenge({
		hostname: 'mail.example.com',
		log: (line) => lines.push(line),
	});
	challenge.hooks.set(TOKEN, ANSWER);
	const { port } = await challenge.listener.listen({
		port: 0,
		hostname: '127.0.0.1',
	});
	stop = () => challenge.listener.stop(true);
	return { base: `http://127.0.0.1:${port}`, port, lines, challenge };
}

/** A raw request, so the path and the Host are exactly as sent. */
async function raw(port: number, request: string): Promise<string> {
	let text = '';
	const done = Promise.withResolvers<void>();
	const socket = await Bun.connect({
		hostname: '127.0.0.1',
		port,
		socket: {
			data(_, data) {
				text += new TextDecoder().decode(data);
			},
			close: () => done.resolve(),
		},
	});
	socket.write(`${request}\r\nConnection: close\r\n\r\n`);
	await done.promise;
	return text;
}

describe('the port 80 listener', () => {
	test('serves the key authorization of a token being validated, and only that', async () => {
		const { base, challenge } = await listening();
		const answer = await fetch(`${base}/.well-known/acme-challenge/${TOKEN}`);
		expect(answer.status).toBe(200);
		expect(await answer.text()).toBe(ANSWER);
		const head = await fetch(`${base}/.well-known/acme-challenge/${TOKEN}`, {
			method: 'HEAD',
		});
		expect(head.status).toBe(200);
		challenge.hooks.remove(TOKEN);
		expect(
			(await fetch(`${base}/.well-known/acme-challenge/${TOKEN}`)).status,
		).toBe(404);
		expect(
			(await fetch(`${base}/.well-known/acme-challenge/unknown`)).status,
		).toBe(404);
	});

	test.each([
		'/index.html',
		'/healthz',
		'/.well-known/',
		'/.well-known/acme-challenge',
		'/.well-known/acme-challenge/',
		'/.well-known/security.txt',
		'/jmap/session',
		'/%2e%2e/etc/passwd',
		'//evil.example/',
		'/\\evil.example',
		'/%2F%2Fevil.example',
		'/index.html?next=https://evil.example',
	])('%s is a 404 with no Location', async (path) => {
		const { port } = await listening();
		const text = await raw(
			port,
			`GET ${path} HTTP/1.1\r\nHost: mail.example.com`,
		);
		expect(text).toStartWith('HTTP/1.1 404 ');
		expect(text).not.toMatch(/^location:/im);
	});

	test('GET / is a 301 to https://<hostname>/, whatever the Host header or the query says: no open redirect', async () => {
		const { port } = await listening();
		for (const [target, host] of [
			['/', 'evil.example'],
			['/', 'mail.example.com.evil.example'],
			['/', 'evil.example:80'],
			['/?next=https://evil.example', 'mail.example.com'],
			['http://evil.example/', 'mail.example.com'],
		]) {
			const text = await raw(port, `GET ${target} HTTP/1.1\r\nHost: ${host}`);
			expect(text).toStartWith('HTTP/1.1 301 ');
			expect(text.toLowerCase()).toContain(
				'location: https://mail.example.com/\r\n',
			);
			expect(text).not.toContain('evil');
		}
	});

	test('whatever the Host header says, a Location is never anything else', async () => {
		const { port } = await listening();
		for (const host of ['//evil.example', 'evil.example/x', '[::1', '']) {
			const text = await raw(port, `GET / HTTP/1.1\r\nHost: ${host}`);
			const location = /^location: (.*)\r$/im.exec(text)?.[1];
			expect(
				location === undefined || location === 'https://mail.example.com/',
			).toBe(true);
		}
	});

	test('only GET of / redirects: HEAD, POST and the rest are 404', async () => {
		const { base } = await listening();
		for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
			const answer = await fetch(`${base}/`, { method, redirect: 'manual' });
			expect(answer.status).toBe(404);
			expect(answer.headers.get('location')).toBeNull();
		}
		const post = await fetch(`${base}/.well-known/acme-challenge/${TOKEN}`, {
			method: 'POST',
		});
		expect(post.status).toBe(404);
	});

	test('logs the first request for a token once, and again for a token set anew', async () => {
		const { base, lines, challenge } = await listening();
		const url = `${base}/.well-known/acme-challenge/${TOKEN}`;
		await fetch(url);
		await fetch(url);
		await fetch(url, { method: 'HEAD' });
		await fetch(`${base}/.well-known/acme-challenge/nope`);
		expect(lines).toEqual(['acme: the CA fetched the challenge evaGxfAD...']);
		challenge.hooks.remove(TOKEN);
		challenge.hooks.set(TOKEN, ANSWER);
		await fetch(url);
		expect(lines).toHaveLength(2);
	});
});
