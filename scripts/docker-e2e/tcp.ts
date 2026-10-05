/** Phase 4: `deploy/compose.traefik-tcp.yaml` — Traefik's TCP routers, PROXY protocol v2, the real client address. */
import { lineWith, textOf, until } from './check';
import { client } from './client-run';
import { imapFetchAll, Smtp } from './protocols';
import { type Context, HOST, traefikCompose } from './setup';
import { behindTraefik, initArgs } from './traefik';

export async function tcpVariant(ctx: Context): Promise<void> {
	const { report, ports, user, password } = ctx;
	console.log(
		'== 4: the TCP variant, PROXY protocol v2, the real client address',
	);
	const direct = traefikCompose(ctx, 'compose.traefik', [
		`${ctx.work}/ports.yaml`,
	]);
	const stop = await direct('rm', '--stop', '--force', 'bumail');
	if (stop.exitCode !== 0)
		throw new Error(`removing the direct bumail failed: ${textOf(stop)}`);
	const tcp = traefikCompose(ctx, 'compose.traefik-tcp');
	const logs = async () => textOf(await tcp('logs', '--no-color', 'bumail'));

	const init = await tcp(
		'run',
		'--rm',
		'-T',
		'bumail',
		...initArgs(),
		'--force',
		...behindTraefik(ctx),
		'--proxy-protocol',
	);
	const initText = textOf(init);
	report.check(
		'bumail init --force with --proxy-protocol keeps the domain and the key',
		init.exitCode === 0 &&
			initText.includes('kept') &&
			initText.includes('wrote /data/bumail.toml'),
		initText
			.split('\n')
			.filter((l) => l.includes('kept'))
			.join(' | ')
			.slice(0, 200),
	);
	const config = textOf(
		await tcp('run', '--rm', '-T', 'bumail', 'check-config'),
	);
	report.check(
		'check-config shows the PROXY protocol',
		/mail proxies\s+1 trusted prox/.test(config),
		lineWith(config, 'mail proxies'),
	);
	const up = await tcp('up', '--detach', 'bumail');
	if (up.exitCode !== 0) throw new Error(`up failed: ${textOf(up)}`);
	const second = await until('bumail serving again', 90, async () => {
		const log = await logs();
		return log.includes('bumail: serving') &&
			log.includes('tls: using the stored certificate')
			? log
			: undefined;
	}).catch(logs);
	report.check(
		'restarts on the volume with the stored certificate, no new order',
		second.includes('tls: using the stored certificate') &&
			!second.includes('tls: waiting for a certificate'),
		lineWith(second, 'stored certificate').slice(0, 160),
	);
	const reach = await until(
		'Traefik to route the TCP services',
		60,
		async () => {
			const answer = await Smtp.connect('127.0.0.1', ports.tcpSubmission, {
				servername: HOST,
			}).catch(() => undefined);
			if (answer === undefined) return undefined;
			const code = answer.greeting.code;
			await answer.smtp.quit();
			return code === 220 ? code : undefined;
		},
	).catch(() => undefined);
	report.check(
		'Traefik TCP router passes 587 through',
		reach === 220,
		reach === undefined
			? 'no greeting'
			: `greeting ${reach} on 127.0.0.1:${ports.tcpSubmission}`,
	);

	const bad = await client(ctx, 'badlogin', 'traefik', '587', user);
	const afterBad = await logs();
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
			ports.tcpImaps,
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
	const tcpLog = await logs();
	report.check(
		'the log shows the real client address on 25',
		tcpLog.split('\n').some((l) => l.includes(ctx.ips.client) && /mx:/.test(l)),
		lineWith(tcpLog, `mx: `).slice(0, 220),
	);
	const jmap = await fetch(
		`https://localhost:${ports.jmapTraefik}/.well-known/jmap`,
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
	const health = await tcp(
		'exec',
		'-T',
		'bumail',
		'/usr/local/bin/bumail',
		'health',
	);
	report.check(
		'bumail health passes in the TCP variant',
		health.exitCode === 0 && textOf(health).trim() === 'ok',
		textOf(health).trim(),
	);
}
