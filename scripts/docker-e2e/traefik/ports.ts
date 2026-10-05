/** Traefik phase 3: the mail ports, JMAP and the health check. */
import tls from 'node:tls';
import { $ } from 'bun';
import { textOf, until } from '../check';
import { logsOf } from '../compose';
import { type Context, HOST } from '../context';
import { mail } from '../mail';
import { imapFetchAll, Smtp } from '../protocols';
import { directCompose } from './init';

export async function ports(ctx: Context): Promise<void> {
	console.log('== 3: the mail ports, JMAP and the health check');
	await submission(ctx);
	await inbound(ctx);
	await jmap(ctx);
	await health(ctx);
}

const has = (lines: string[], re: RegExp) => lines.some((l) => re.test(l));

/** 587: STARTTLS first, AUTH after, the message read back over IMAPS. */
async function submission(ctx: Context): Promise<void> {
	const { report, user, password } = ctx;
	const { smtp, greeting } = await Smtp.connect(
		'127.0.0.1',
		ctx.ports.submission,
		{
			servername: HOST,
		},
	);
	report.check('587 greets', greeting.code === 220, greeting.lines[0] ?? '');
	const ehlo = await smtp.command('EHLO e2e.bumail.test');
	report.check(
		'587 offers STARTTLS and no AUTH before it',
		has(ehlo.lines, /STARTTLS/) && !has(ehlo.lines, /AUTH/),
		ehlo.lines.join(' | '),
	);
	const early = await smtp.authPlain(user, password);
	report.check(
		'587 refuses AUTH without TLS',
		early.code >= 500 && early.code < 600,
		`${early.code}`,
	);
	const starttls = await smtp.startTls(HOST);
	report.check('587 STARTTLS', starttls.code === 220, starttls.lines[0] ?? '');
	const cert = smtp.certificate;
	report.check(
		'the certificate on 587 was issued by the test CA for the host',
		/Pebble/.test(cert.issuer) && cert.subjectaltname.includes(HOST),
		`${cert.issuer}; ${cert.subjectaltname}`,
	);
	const secure = await smtp.command('EHLO e2e.bumail.test');
	report.check(
		'587 offers AUTH after STARTTLS',
		has(secure.lines, /AUTH/),
		secure.lines.join(' | '),
	);
	const wrong = await smtp.authPlain(user, 'not-the-password');
	report.check(
		'587 refuses a wrong password',
		wrong.code === 535,
		`${wrong.code}`,
	);
	const auth = await smtp.authPlain(user, password);
	report.check('587 AUTH succeeds', auth.code === 235, `${auth.code}`);
	const subject = `submission ${ctx.run}`;
	const sent = await smtp.send(user, user, mail(user, subject));
	report.check(
		'587 accepts the message',
		sent.code === 250,
		sent.lines.join(' | '),
	);
	await smtp.quit();
	const got = await until('the message in the mailbox', 30, async () => {
		const read = await imapFetchAll(
			'127.0.0.1',
			ctx.ports.imaps,
			user,
			password,
			HOST,
		);
		return read.text.includes(`Subject: ${subject}`) ? read : undefined;
	}).catch(() => undefined);
	report.check(
		'the message landed, read back over IMAPS 993',
		got !== undefined,
		got === undefined
			? 'not found'
			: `certificate by ${got.certificate.issuer}`,
	);
}

/** 25: STARTTLS, never AUTH, never a relay. */
async function inbound(ctx: Context): Promise<void> {
	const { report, user } = ctx;
	const mx = await Smtp.connect('127.0.0.1', ctx.ports.mx, {
		servername: HOST,
	});
	const ehlo = await mx.smtp.command('EHLO e2e.bumail.test');
	report.check(
		'25 offers STARTTLS and no AUTH',
		has(ehlo.lines, /STARTTLS/) && !has(ehlo.lines, /AUTH/),
		ehlo.lines.join(' | '),
	);
	await mx.smtp.startTls(HOST);
	const secure = await mx.smtp.command('EHLO e2e.bumail.test');
	report.check(
		'25 offers no AUTH after STARTTLS either',
		secure.code === 250 && !has(secure.lines, /AUTH/),
		secure.lines.join(' | '),
	);
	const relay = await mx.smtp.send(
		'someone@elsewhere.example',
		'victim@elsewhere.example',
		mail(user, 'relay'),
	);
	report.check(
		'25 does not relay for strangers',
		relay.code >= 500 && relay.code < 600,
		relay.lines.join(' | '),
	);
	await mx.smtp.quit();
}

/** JMAP through Traefik, and Traefik's own certificate for HTTPS. */
async function jmap(ctx: Context): Promise<void> {
	const { report, user, password } = ctx;
	const url = `https://localhost:${ctx.ports.jmapTraefik}/.well-known/jmap`;
	const login = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
	const session = await fetch(url, {
		headers: { Host: HOST, Authorization: login },
		tls: { rejectUnauthorized: false },
		redirect: 'manual',
	}).catch(() => undefined);
	const body = (await session?.json().catch(() => ({}))) as
		| { apiUrl?: string }
		| undefined;
	report.check(
		'JMAP answers through Traefik',
		session?.status === 200 && body?.apiUrl === `https://${HOST}/jmap/api`,
		`HTTP ${session?.status}; apiUrl ${body?.apiUrl}`,
	);
	const issuer = await until("Traefik's own certificate", 90, () =>
		issuerOn(ctx.ports.jmapTraefik, HOST),
	).catch(() => undefined);
	report.check(
		'Traefik keeps its own certificate for HTTPS (from its resolver, on the test CA)',
		issuer !== undefined,
		issuer ?? 'it served its default certificate',
	);
	const anonymous = await fetch(url, {
		headers: { Host: HOST },
		tls: { rejectUnauthorized: false },
		redirect: 'manual',
	}).catch(() => undefined);
	report.check(
		'JMAP refuses a request without a login',
		anonymous?.status === 401,
		`HTTP ${anonymous?.status}`,
	);
}

/** `bumail health`, Docker's own verdict, and a log with no password in it. */
async function health(ctx: Context): Promise<void> {
	const { report, password } = ctx;
	const direct = directCompose(ctx);
	const out = await direct('exec', '-T', 'bumail', 'bumail', 'health');
	report.check(
		'bumail health passes',
		out.exitCode === 0 && textOf(out).trim() === 'ok',
		textOf(out).trim(),
	);
	const status = await until(
		'the container to report healthy',
		120,
		async () => {
			const id = textOf(await direct('ps', '--quiet', 'bumail')).trim();
			const state = (
				await $`docker inspect ${id} --format ${'{{.State.Health.Status}}'}`.text()
			).trim();
			return state === 'healthy' ? state : undefined;
		},
	).catch(() => 'not healthy in time');
	report.check(
		"Docker's HEALTHCHECK reports healthy",
		status === 'healthy',
		status,
	);
	const log = await logsOf(direct);
	report.check(
		'the log names no password',
		!log.includes(password) && !log.includes('not-the-password'),
		'',
	);
}

/** The test CA's issuer of the certificate served on `port` for `servername`; else `undefined`. */
function issuerOn(
	port: number,
	servername: string,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const socket = tls.connect(
			{ host: '127.0.0.1', port, servername, rejectUnauthorized: false },
			() => {
				const issuer = Object.values(
					socket.getPeerCertificate().issuer ?? {},
				).join(' ');
				socket.destroy();
				resolve(/Pebble/.test(issuer) ? issuer : undefined);
			},
		);
		socket.on('error', () => resolve(undefined));
	});
}
