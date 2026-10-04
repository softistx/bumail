import { createSmtpServer, reply, type SmtpServer } from '@bumail/smtp';
import { selfSigned } from '../config/certificates.fixtures';

/** A message a sink took: its envelope, its bytes as text, and who logged in. */
export interface Taken {
	readonly from: string;
	readonly to: readonly string[];
	readonly text: string;
	readonly user: string | undefined;
}

/** Another server, on 127.0.0.1, keeping what it takes. */
export interface Sink {
	readonly port: number;
	readonly taken: Taken[];
	/** The certificate it presents, for a client to trust. */
	readonly cert: string;
	/** Waits until it took `count` messages, for at most 10 s. */
	until(count: number): Promise<Taken[]>;
	stop(): void;
}

/** One certificate for every sink, so one CA trusts them all. */
let sinkTls: ReturnType<typeof selfSigned> | undefined;

/**
 * An SMTP server standing for the rest of the world: an MX for
 * `remote.example` refusing `nobody@` with 550, or, with `auth`, a
 * smarthost taking anything from that user, STARTTLS offered either way.
 */
export async function startSink(
	auth?: { readonly username: string; readonly password: string },
	options: { readonly delayMs?: number } = {},
): Promise<Sink> {
	sinkTls ??= selfSigned(['127.0.0.1', 'localhost']);
	const tls = await sinkTls;
	const taken: Taken[] = [];
	const server: SmtpServer = createSmtpServer({
		hostname: auth === undefined ? 'mx.remote.example' : 'smarthost.example',
		mode: auth === undefined ? 'mx' : 'submission',
		localDomains: ['remote.example'],
		tls,
		...(auth === undefined
			? {}
			: {
					authenticate: ({ username, password }) =>
						username === auth.username && password === auth.password,
				}),
		onRcptTo: (path) =>
			path.local === 'nobody'
				? reply(550, '5.1.1', 'No such user here')
				: undefined,
		async onData(message, session) {
			const text = await new Response(message.content).text();
			if (options.delayMs !== undefined) await Bun.sleep(options.delayMs);
			taken.push({
				from: message.envelope.from,
				to: message.envelope.to,
				text,
				user: session.user,
			});
		},
	});
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return {
		port,
		taken,
		cert: tls.cert,
		async until(count) {
			const end = Date.now() + 10_000;
			while (taken.length < count && Date.now() < end) await Bun.sleep(20);
			return taken;
		},
		stop: () => server.stop(true),
	};
}
