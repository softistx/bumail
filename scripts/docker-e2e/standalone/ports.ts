/** Standalone phase 0c: the mail ports, JMAP, health, and `bumail dns`. */
import { textOf, until } from '../check';
import { logsOf, standaloneCompose } from '../compose';
import { type Context, DOMAIN, STANDALONE_HOST } from '../context';
import { mail } from '../mail';
import { imapFetchAll, Smtp } from '../protocols';

export async function ports(ctx: Context): Promise<void> {
	await mailPorts(ctx);
	await jmapAndHealth(ctx);
}

async function mailPorts(ctx: Context): Promise<void> {
	const { report, user, password } = ctx;
	const lone = await Smtp.connect('127.0.0.1', ctx.ports.submission, {
		servername: STANDALONE_HOST,
	});
	await lone.smtp.command('EHLO e2e.bumail.test');
	await lone.smtp.startTls(STANDALONE_HOST);
	await lone.smtp.command('EHLO e2e.bumail.test');
	const auth = await lone.smtp.authPlain(user, password);
	const subject = `standalone ${ctx.run}`;
	const sent =
		auth.code === 235
			? await lone.smtp.send(user, user, mail(user, subject))
			: auth;
	report.check(
		'standalone: 587 STARTTLS, AUTH and the message accepted',
		auth.code === 235 && sent.code === 250,
		`${auth.code} ${sent.code}; certificate by ${lone.smtp.certificate.issuer}`,
	);
	await lone.smtp.quit();
	const got = await until('the standalone message', 30, async () => {
		const read = await imapFetchAll(
			'127.0.0.1',
			ctx.ports.imaps,
			user,
			password,
			STANDALONE_HOST,
		);
		return read.text.includes(`Subject: ${subject}`) ? read : undefined;
	}).catch(() => undefined);
	report.check(
		'standalone: the message read back over IMAPS 993',
		got !== undefined,
		got === undefined
			? 'not found'
			: `certificate by ${got.certificate.issuer}`,
	);
	const mx = await Smtp.connect('127.0.0.1', ctx.ports.mx, {
		servername: STANDALONE_HOST,
	});
	const ehlo = await mx.smtp.command('EHLO e2e.bumail.test');
	report.check(
		'standalone: 25 offers STARTTLS and no AUTH',
		ehlo.lines.some((l) => /STARTTLS/.test(l)) &&
			!ehlo.lines.some((l) => /AUTH/.test(l)),
		ehlo.lines.join(' | '),
	);
	await mx.smtp.quit();
}

async function jmapAndHealth(ctx: Context): Promise<void> {
	const { report, user, password } = ctx;
	const alone = standaloneCompose(ctx);
	const jmap = await fetch(
		`https://localhost:${ctx.ports.jmapDirect}/.well-known/jmap`,
		{
			headers: {
				Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
			},
			tls: { rejectUnauthorized: false },
		},
	).catch(() => undefined);
	report.check(
		'standalone: JMAP answers over HTTPS on 443',
		jmap?.status === 200,
		`HTTP ${jmap?.status}`,
	);
	const health = await alone('exec', '-T', 'bumail', 'bumail', 'health');
	report.check(
		'standalone: bumail health passes',
		health.exitCode === 0 && textOf(health).trim() === 'ok',
		textOf(health).trim(),
	);
	await dnsZone(ctx);
	await until('the standalone container to report healthy', 120, async () =>
		textOf(await alone('ps')).includes('(healthy)'),
	);
	const log = (await logsOf(alone))
		.split('\n')
		.filter((l) => /^(tls|acme|bumail): /.test(l))
		.slice(0, 12)
		.join('\n');
	console.log(`---- the standalone log\n${log}\n----`);
	console.log(`---- docker compose ps\n${textOf(await alone('ps'))}----`);
	await alone('down', '--volumes', '--timeout', '30');
}

/** `bumail dns`, and `--check` against the test DNS, which holds the host's A record only. */
async function dnsZone(ctx: Context): Promise<void> {
	const alone = standaloneCompose(ctx);
	const ip = ctx.ips.standalone;
	const zone = await alone('exec', '-T', 'bumail', 'bumail', 'dns', '--ip', ip);
	const zoneText = zone.stdout.toString();
	console.log(`---- bumail dns --ip ${ip}\n${zoneText}----`);
	ctx.report.check(
		'standalone: bumail dns prints the zone (A, MX, SPF, DKIM, DMARC)',
		zone.exitCode === 0 &&
			zoneText.includes(`${STANDALONE_HOST}. IN A ${ip}`) &&
			zoneText.includes(`${DOMAIN}. IN MX 10 ${STANDALONE_HOST}.`) &&
			zoneText.includes('bumail._domainkey'),
		'',
	);
	const check = await alone(
		'exec',
		'-T',
		'bumail',
		'bumail',
		'dns',
		'--ip',
		ip,
		'--check',
	);
	const text = textOf(check);
	console.log(
		`---- bumail dns --ip ${ip} --check (exit ${check.exitCode})\n${text}----`,
	);
	ctx.report.check(
		'standalone: bumail dns --check finds the A record the test DNS holds and reports the PTR and the TXT records missing (partial; no MX answer: unavailable; exit 1)',
		check.exitCode === 1 &&
			/ok\s+A\s+standalone\.bumail\.test/.test(text) &&
			/missing\s+TXT\s+_dmarc/.test(text) &&
			/missing\s+PTR/.test(text),
		'',
	);
}
