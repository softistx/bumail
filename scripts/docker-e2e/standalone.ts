/** Phase 0: the standalone variant (`deploy/compose.yaml`), where bumail binds port 80 itself. */

import { $ } from 'bun';
import { lineWith, textOf, until } from './check';
import { imapFetchAll, Smtp } from './protocols';
import {
	addHost,
	type Context,
	DOMAIN,
	PEBBLE_DIRECTORY,
	ROOT,
	STANDALONE_HOST,
	standaloneCompose,
} from './setup';

export async function standalone(ctx: Context): Promise<void> {
	const { report, ports, user, password } = ctx;
	console.log(
		'== 0: the standalone variant (compose.yaml): bumail binds 80 itself',
	);
	await addHost(ctx, STANDALONE_HOST, ctx.ips.standalone);
	const alone = standaloneCompose(ctx);
	const init = await alone(
		'run',
		'--rm',
		'-T',
		'bumail',
		'init',
		'--hostname',
		STANDALONE_HOST,
		'--domain',
		DOMAIN,
		'--acme-directory',
		PEBBLE_DIRECTORY,
	);
	report.check(
		'standalone: bumail init with the flags the guide uses',
		init.exitCode === 0 && textOf(init).includes('wrote /data/bumail.toml'),
		lineWith(textOf(init), 'wrote'),
	);
	const added =
		await $`echo ${password} | docker compose -p ${ctx.standaloneProject} -f ${ROOT}/deploy/compose.yaml -f ${ROOT}/deploy/test/e2e-standalone.yaml -f ${ctx.work}/standalone-ports.yaml run --rm -T bumail user add ${user} --password-stdin`
			.env({ ...ctx.env, BUMAIL_HOST: STANDALONE_HOST })
			.nothrow()
			.quiet();
	report.check(
		'standalone: bumail user add',
		added.exitCode === 0 && textOf(added).includes(`added the user ${user}`),
		textOf(added).trim(),
	);
	const up = await alone('up', '--detach', 'bumail');
	if (up.exitCode !== 0) throw new Error(`standalone up failed: ${textOf(up)}`);
	const logs = async () =>
		textOf(await alone('logs', '--no-color', '--no-log-prefix', 'bumail'));
	const log = await until('the standalone certificate', 120, async () => {
		const text = await logs();
		return text.includes('tls: obtained (') ? text : undefined;
	}).catch(logs);
	report.check(
		"standalone: the certificate was obtained, the CA reaching bumail's own port 80",
		log.includes('tls: obtained (') &&
			log.includes('acme: the CA fetched the challenge'),
		lineWith(log, 'tls: obtained') || log.slice(-300),
	);
	await until('standalone serving', 60, async () =>
		(await logs()).includes('bumail: serving'),
	);

	const lone = await Smtp.connect('127.0.0.1', ports.submission, {
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
			ports.imaps,
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
	const mx = await Smtp.connect('127.0.0.1', ports.mx, {
		servername: STANDALONE_HOST,
	});
	const ehlo = await mx.smtp.command('EHLO e2e.bumail.test');
	report.check(
		'standalone: 25 offers STARTTLS and no AUTH',
		ehlo.lines.some((l) => /STARTTLS/.test(l)) &&
			!ehlo.lines.some((l) => /AUTH/.test(l)),
		'',
	);
	await mx.smtp.quit();
	const jmap = await fetch(
		`https://localhost:${ports.jmapDirect}/.well-known/jmap`,
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
	const health = await alone(
		'exec',
		'-T',
		'bumail',
		'/usr/local/bin/bumail',
		'health',
	);
	report.check(
		'standalone: bumail health passes',
		health.exitCode === 0 && textOf(health).trim() === 'ok',
		textOf(health).trim(),
	);

	const zone = await alone(
		'exec',
		'-T',
		'bumail',
		'/usr/local/bin/bumail',
		'dns',
		'--ip',
		ctx.ips.standalone,
	);
	const zoneText = zone.stdout.toString();
	console.log(`---- bumail dns --ip ${ctx.ips.standalone}\n${zoneText}----`);
	report.check(
		'standalone: bumail dns prints the zone (A, MX, SPF, DKIM, DMARC)',
		zone.exitCode === 0 &&
			zoneText.includes(`${STANDALONE_HOST}. IN A ${ctx.ips.standalone}`) &&
			zoneText.includes(`${DOMAIN}. IN MX 10 ${STANDALONE_HOST}.`) &&
			zoneText.includes('bumail._domainkey'),
		'',
	);
	// The test DNS holds the host's A record only: a partial check. The A record is found; the PTR and the TXT records are missing; the MX is unanswered (unavailable); exit 1.
	const check = await alone(
		'exec',
		'-T',
		'bumail',
		'/usr/local/bin/bumail',
		'dns',
		'--ip',
		ctx.ips.standalone,
		'--check',
	);
	const checkText = textOf(check);
	console.log(
		`---- bumail dns --ip ${ctx.ips.standalone} --check (exit ${check.exitCode})\n${checkText}----`,
	);
	report.check(
		'standalone: bumail dns --check finds the A record the test DNS holds and reports the PTR and the TXT records missing (partial; no MX answer: unavailable; exit 1)',
		check.exitCode === 1 &&
			/ok\s+A\s+standalone\.bumail\.test/.test(checkText) &&
			/missing\s+TXT\s+_dmarc/.test(checkText) &&
			/missing\s+PTR/.test(checkText),
		'',
	);
	console.log(
		`---- the standalone log\n${(await logs())
			.split('\n')
			.filter((l) => /^(tls|acme|bumail): /.test(l))
			.slice(0, 12)
			.join('\n')}\n----`,
	);
	await until('the standalone container to report healthy', 120, async () =>
		textOf(await alone('ps')).includes('(healthy)'),
	);
	console.log(`---- docker compose ps\n${textOf(await alone('ps'))}----`);
	await alone('down', '--volumes', '--timeout', '30');
}

/** A short message from `from` to itself. */
export function mail(from: string, subject: string): string {
	return `From: <${from}>\r\nTo: <${from}>\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@e2e.bumail.test>\r\n\r\nHello from the end-to-end test.\r\n`;
}
