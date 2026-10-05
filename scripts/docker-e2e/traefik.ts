/** Phases 1 to 3: `deploy/compose.traefik.yaml` — init, the certificate through Traefik's challenge route, the mail ports, JMAP, health. */
import tls from 'node:tls';
import { $ } from 'bun';
import { lineWith, textOf, until } from './check';
import { imapFetchAll, Smtp } from './protocols';
import {
	type Context,
	DOMAIN,
	HOST,
	PEBBLE_DIRECTORY,
	ROOT,
	traefikCompose,
} from './setup';
import { mail } from './standalone';

/** The init flags of the guide's Traefik variant, for this run's network. */
export const initArgs = (): string[] => [
	'init',
	'--hostname',
	HOST,
	'--domain',
	DOMAIN,
	'--acme-email',
	`postmaster@${DOMAIN}`,
	'--acme-directory',
	PEBBLE_DIRECTORY,
];
export const behindTraefik = (ctx: Context): string[] => [
	'--behind-traefik',
	'--trusted-proxy',
	ctx.subnet,
];

export async function traefikVariant(ctx: Context): Promise<void> {
	const { report, ports, user, password } = ctx;
	const direct = traefikCompose(ctx, 'compose.traefik', [
		`${ctx.work}/ports.yaml`,
	]);
	const logs = async () => textOf(await direct('logs', '--no-color', 'bumail'));

	console.log('== 1: init and a user (the guide, steps 3 and 4)');
	const init = await direct(
		'run',
		'--rm',
		'-T',
		'bumail',
		...initArgs(),
		...behindTraefik(ctx),
	);
	report.check(
		'bumail init writes the configuration and the DKIM key',
		init.exitCode === 0 &&
			textOf(init).includes('wrote /data/bumail.toml') &&
			textOf(init).includes('generated an RSA-2048 DKIM key'),
		lineWith(textOf(init), 'wrote'),
	);
	const again = await direct(
		'run',
		'--rm',
		'-T',
		'bumail',
		...initArgs(),
		...behindTraefik(ctx),
	);
	report.check(
		'bumail init refuses to overwrite',
		again.exitCode === 4 &&
			textOf(again).includes('exists; --force replaces it'),
		`exit ${again.exitCode}; ${lineWith(textOf(again), 'exists')}`,
	);
	const config = await direct('run', '--rm', '-T', 'bumail', 'check-config');
	report.check(
		'bumail check-config accepts it',
		config.exitCode === 0 && textOf(config).includes('/data/bumail.toml: ok'),
		'',
	);
	const added =
		await $`echo ${password} | docker compose -p ${ctx.project} -f ${ROOT}/deploy/compose.traefik.yaml -f ${ROOT}/deploy/test/e2e.yaml run --rm -T bumail user add ${user} --password-stdin`
			.env(ctx.env)
			.nothrow()
			.quiet();
	report.check(
		'bumail user add',
		added.exitCode === 0 && textOf(added).includes(`added the user ${user}`),
		textOf(added).trim().split('\n')[0] ?? '',
	);

	console.log('== 2: up, and the certificate through the challenge route');
	const up = await direct('up', '--detach', 'bumail');
	if (up.exitCode !== 0) throw new Error(`up failed: ${textOf(up)}`);
	const started = await until('the certificate', 120, async () => {
		const log = await logs();
		return log.includes('tls: obtained (') ? log : undefined;
	}).catch(logs);
	report.check(
		'the certificate was obtained from the CA',
		started.includes('tls: obtained ('),
		lineWith(started, 'tls: obtained') || started.slice(-300),
	);
	report.check(
		'the CA fetched the challenge (through Traefik)',
		started.includes('acme: the CA fetched the challenge'),
		lineWith(started, 'the CA fetched'),
	);
	const traefikLog = textOf(await direct('logs', '--no-color', 'traefik'));
	report.check(
		'Traefik routed it with the bumail-acme router',
		/acme-challenge[^\n]*bumail-acme@docker/.test(traefikLog),
		lineWith(traefikLog, 'bumail-acme@docker').slice(0, 200) ||
			'no access log line',
	);
	await until('bumail serving', 60, async () =>
		(await logs()).includes('bumail: serving'),
	);

	console.log('== 3: the mail ports, JMAP and the health check');
	const { smtp, greeting } = await Smtp.connect('127.0.0.1', ports.submission, {
		servername: HOST,
	});
	report.check('587 greets', greeting.code === 220, greeting.lines[0] ?? '');
	const ehlo = await smtp.command('EHLO e2e.bumail.test');
	report.check(
		'587 offers STARTTLS and no AUTH before it',
		ehlo.lines.some((l) => /STARTTLS/.test(l)) &&
			!ehlo.lines.some((l) => /AUTH/.test(l)),
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
		secure.lines.some((l) => /AUTH/.test(l)),
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
			ports.imaps,
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

	const mx = await Smtp.connect('127.0.0.1', ports.mx, { servername: HOST });
	const mxEhlo = await mx.smtp.command('EHLO e2e.bumail.test');
	report.check(
		'25 offers STARTTLS and no AUTH',
		mxEhlo.lines.some((l) => /STARTTLS/.test(l)) &&
			!mxEhlo.lines.some((l) => /AUTH/.test(l)),
		mxEhlo.lines.join(' | '),
	);
	await mx.smtp.startTls(HOST);
	const mxSecure = await mx.smtp.command('EHLO e2e.bumail.test');
	report.check(
		'25 offers no AUTH after STARTTLS either',
		mxSecure.code === 250 && !mxSecure.lines.some((l) => /AUTH/.test(l)),
		mxSecure.lines.join(' | '),
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

	const jmapUrl = `https://localhost:${ports.jmapTraefik}/.well-known/jmap`;
	const session = await fetch(jmapUrl, {
		headers: {
			Host: HOST,
			Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
		},
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
		issuerOn(ports.jmapTraefik, HOST),
	).catch(() => undefined);
	report.check(
		'Traefik keeps its own certificate for HTTPS (from its resolver, on the test CA)',
		issuer !== undefined,
		issuer ?? 'it served its default certificate',
	);
	const anonymous = await fetch(jmapUrl, {
		headers: { Host: HOST },
		tls: { rejectUnauthorized: false },
		redirect: 'manual',
	}).catch(() => undefined);
	report.check(
		'JMAP refuses a request without a login',
		anonymous?.status === 401,
		`HTTP ${anonymous?.status}`,
	);

	const health = await direct(
		'exec',
		'-T',
		'bumail',
		'/usr/local/bin/bumail',
		'health',
	);
	report.check(
		'bumail health passes',
		health.exitCode === 0 && textOf(health).trim() === 'ok',
		textOf(health).trim(),
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
	const directLog = await logs();
	report.check(
		'the log names no password',
		!directLog.includes(password) && !directLog.includes('not-the-password'),
		'',
	);
}

/** The issuer's name of the certificate served on `port` for `servername` when it is the test CA's; else `undefined`. */
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
