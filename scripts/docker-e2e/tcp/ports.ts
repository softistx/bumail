/** TCP phase 4c: Traefik's TCP routers, PROXY protocol v2, the real client address. */
import { lineWith, until } from '../check';
import { client } from '../client-run';
import { logsOf } from '../compose';
import { type Context, HOST } from '../context';
import { imapFetchAll, Smtp } from '../protocols';
import { tcpCompose } from './init';

export async function ports(ctx: Context): Promise<void> {
	await reach(ctx);
	await realClient(ctx);
	await jmapAndHealth(ctx);
}

/** Traefik has to route the TCP services before the first connection counts. */
async function reach(ctx: Context): Promise<void> {
	const greeting = await until(
		'Traefik to route the TCP services',
		60,
		async () => {
			const answer = await Smtp.connect('127.0.0.1', ctx.ports.tcpSubmission, {
				servername: HOST,
			}).catch(() => undefined);
			if (answer === undefined) return undefined;
			const code = answer.greeting.code;
			await answer.smtp.quit();
			return code === 220 ? code : undefined;
		},
	).catch(() => undefined);
	ctx.report.check(
		'Traefik TCP router passes 587 through',
		greeting === 220,
		greeting === undefined
			? 'no greeting'
			: `greeting ${greeting} on 127.0.0.1:${ctx.ports.tcpSubmission}`,
	);
}

/** A container at a known address submits and delivers; the log and the headers name it, not Traefik. */
async function realClient(ctx: Context): Promise<void> {
	const { report, user, password } = ctx;
	const tcp = tcpCompose(ctx);
	const bad = await client(ctx, 'badlogin', 'traefik', '587', user);
	const afterBad = await logsOf(tcp);
	report.check(
		'a refused login names the real client, not Traefik',
		bad['auth'] === 535 &&
			afterBad.includes(`login refused from ${ctx.ips.client}:`) &&
			!afterBad.includes(`login refused from ${ctx.ips.traefik}`),
		lineWith(afterBad, 'login refused'),
	);
	const viaSubject = `via traefik ${ctx.run}`;
	const viaSent = await client(
		ctx,
		'submit',
		'traefik',
		'587',
		user,
		password,
		user,
		user,
		viaSubject,
	);
	report.check(
		'submission on 587 through Traefik: STARTTLS, AUTH, accepted',
		viaSent['auth'] === 235 && viaSent['sent'] === 250,
		JSON.stringify(viaSent).slice(0, 160),
	);
	const inboundSubject = `inbound ${ctx.run}`;
	const inbound = await client(
		ctx,
		'deliver',
		'traefik',
		'25',
		`sender@${HOST}`,
		user,
		inboundSubject,
	);
	report.check(
		'mail from another server through Traefik on 25 is accepted',
		inbound['sent'] === 250,
		JSON.stringify(inbound).slice(0, 200),
	);
	const both = await until('both messages', 30, async () => {
		const read = await imapFetchAll(
			'127.0.0.1',
			ctx.ports.tcpImaps,
			user,
			password,
			HOST,
		);
		return read.text.includes(viaSubject) && read.text.includes(inboundSubject)
			? read
			: undefined;
	}).catch(() => undefined);
	report.check(
		'both landed, read back over IMAPS 993 through Traefik',
		both !== undefined,
		both === undefined
			? 'not found'
			: `certificate by ${both.certificate.issuer}`,
	);
	const received = (both?.text ?? '')
		.split('\n')
		.filter((l) => /^Received:/i.test(l));
	report.check(
		'the Received header names the real client address',
		received.some((l) => l.includes(`[${ctx.ips.client}]`)) &&
			!received.some((l) => l.includes(`[${ctx.ips.traefik}]`)),
		received.join(' | ').slice(0, 300),
	);
	const log = await logsOf(tcp);
	report.check(
		'the log shows the real client address on 25',
		log.split('\n').some((l) => l.includes(ctx.ips.client) && /mx:/.test(l)),
		lineWith(log, 'mx: ').slice(0, 220),
	);
}

async function jmapAndHealth(ctx: Context): Promise<void> {
	const { report, user, password } = ctx;
	const jmap = await fetch(
		`https://localhost:${ctx.ports.jmapTraefik}/.well-known/jmap`,
		{
			headers: {
				Host: HOST,
				Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
			},
			tls: { rejectUnauthorized: false },
		},
	).catch(() => undefined);
	report.check(
		'JMAP still answers through Traefik in the TCP variant',
		jmap?.status === 200,
		`HTTP ${jmap?.status}`,
	);
	const health = await tcpCompose(ctx)(
		'exec',
		'-T',
		'bumail',
		'bumail',
		'health',
	);
	const text = `${health.stdout}${health.stderr}`.trim();
	report.check(
		'bumail health passes in the TCP variant',
		health.exitCode === 0 && text === 'ok',
		text,
	);
}
