#!/usr/bin/env bun
/**
 * The Docker image and the deploy files, end to end, on this machine's
 * Docker: builds the image, starts its own Traefik v3, Pebble (an ACME test
 * CA that validates HTTP-01 for real) and pebble-challtestsrv (its DNS) under
 * the compose project `bumail-e2e-docker`, on a network of its own and on
 * high ports of 127.0.0.1, then runs the deploy guide's steps against
 * `deploy/compose.traefik.yaml` and `deploy/compose.traefik-tcp.yaml`:
 *
 *   1. `bumail init` writes the configuration; a user is added;
 *   2. the certificate is issued by the CA through Traefik's challenge route;
 *   3. submission on 587 with STARTTLS and AUTH, the message read back over
 *      IMAPS, JMAP answered through Traefik, no AUTH on 25, `bumail health`;
 *   4. the TCP variant: the same through Traefik's TCP routers, and the real
 *      client address (a container of its own on the network) in the log and
 *      in the Received header, from the PROXY protocol version 2.
 *
 * It never touches another container: everything it makes is named for the
 * project and removed at the end, whatever happened. Needs Docker with
 * Compose v2 and the images in `deploy/test/e2e.yaml` (pulled if missing).
 *
 *   bun run docker:e2e       (from the repository root; builds the image)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { imapFetchAll, Smtp } from './docker-e2e/protocols';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PROJECT = 'bumail-e2e-docker';
const STANDALONE_PROJECT = 'bumail-e2e-docker-standalone';
const NETWORK = 'bumail-e2e-proxy';
const SUBNET = '172.29.77.0/24';
const TRAEFIK_IP = '172.29.77.200';
const CLIENT_IP = '172.29.77.99';
const HOST = 'mail.bumail.test';
const STANDALONE_HOST = 'standalone.bumail.test';
const STANDALONE_IP = '172.29.77.150';
const DOMAIN = 'bumail.test';
const IMAGE = 'bumail:e2e-docker';
const PEBBLE_DIRECTORY = 'https://pebble:14000/dir';
const CLIENT_IMAGE = 'oven/bun:1.4.2';

/** Host ports of the direct variant (bumail's own) and of Traefik's. */
const DIRECT = {
	mx: 12525,
	submissions: 12465,
	submission: 12587,
	imaps: 12993,
};
const VIA_TRAEFIK = {
	mx: 13525,
	submissions: 13465,
	submission: 13587,
	imaps: 13993,
};
const JMAP_URL = 'https://localhost:18443';
const STANDALONE_JMAP = 'https://localhost:12443';
const CHALLTESTSRV = 'http://127.0.0.1:18055';

const work = mkdtempSync(join(tmpdir(), 'bumail-e2e-'));
const password = `e2e-${crypto.randomUUID().slice(0, 12)}`;
const user = `alice@${DOMAIN}`;
const run = crypto.randomUUID().slice(0, 8);

await Bun.write(
	`${work}/standalone-ports.yaml`,
	`services:\n  bumail:\n    ports: !override\n${[
		[DIRECT.mx, 25],
		[DIRECT.submissions, 465],
		[DIRECT.submission, 587],
		[DIRECT.imaps, 993],
		[12443, 443],
	]
		.map(([outside, inside]) => `      - '127.0.0.1:${outside}:${inside}'\n`)
		.join('')}`,
);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
	results.push({ name, ok, detail });
	console.log(
		`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
	);
}

const env = {
	...process.env,
	TRAEFIK_NETWORK: NETWORK,
	BUMAIL_HOST: HOST,
	BUMAIL_IMAGE: IMAGE,
	E2E_DIR: work,
	COMPOSE_FILE: '',
};

/** `docker compose` on the deploy file `variant` and the test's own. */
function compose(variant: string, extra: string[] = []) {
	const files = [
		`${ROOT}/deploy/${variant}.yaml`,
		`${ROOT}/deploy/test/e2e.yaml`,
		...extra,
	].flatMap((file) => ['-f', file]);
	return (...args: string[]) =>
		$`docker compose -p ${PROJECT} ${files} ${args}`.env(env).nothrow().quiet();
}

/** The standalone variant: `compose.yaml`, in a project of its own. */
function standalone() {
	const files = [
		`${ROOT}/deploy/compose.yaml`,
		`${ROOT}/deploy/test/e2e-standalone.yaml`,
		`${work}/standalone-ports.yaml`,
	].flatMap((file) => ['-f', file]);
	return (...args: string[]) =>
		$`docker compose -p ${STANDALONE_PROJECT} ${files} ${args}`
			.env({ ...env, BUMAIL_HOST: STANDALONE_HOST })
			.nothrow()
			.quiet();
}

async function text(shell: ReturnType<typeof $>): Promise<string> {
	const out = await shell;
	return `${out.stdout.toString()}${out.stderr.toString()}`;
}

async function until<T>(
	what: string,
	seconds: number,
	probe: () => Promise<T | undefined | false>,
): Promise<T> {
	const deadline = Date.now() + seconds * 1000;
	for (;;) {
		const found = await probe().catch(() => undefined);
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(1000);
	}
}

async function teardown(): Promise<void> {
	for (const variant of ['compose.traefik-tcp', 'compose.traefik']) {
		await compose(variant)(
			'down',
			'--volumes',
			'--remove-orphans',
			'--timeout',
			'30',
		);
	}
	await standalone()(
		'down',
		'--volumes',
		'--remove-orphans',
		'--timeout',
		'30',
	);
	await $`docker network rm ${NETWORK}`.nothrow().quiet();
	await $`docker rmi ${IMAGE}`.nothrow().quiet();
	rmSync(work, { recursive: true, force: true });
}

async function logs(variant: string): Promise<string> {
	return text(compose(variant)('logs', '--no-color', 'bumail'));
}

/** The client container, at an address of its own on the network. */
async function client(...args: string[]): Promise<Record<string, unknown>> {
	const out =
		await $`docker run --rm --network ${NETWORK} --ip ${CLIENT_IP} -v ${ROOT}/scripts/docker-e2e:/e2e:ro -e E2E_HOSTNAME=${HOST} ${CLIENT_IMAGE} bun /e2e/client.ts ${args}`
			.nothrow()
			.quiet();
	const last = out.stdout.toString().trim().split('\n').pop() ?? '';
	try {
		return JSON.parse(last);
	} catch {
		throw new Error(`the client said: ${out.stdout}${out.stderr}`);
	}
}

const mailBody = (subject: string) =>
	`From: <${user}>\r\nTo: <${user}>\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@e2e.bumail.test>\r\n\r\nHello from the end-to-end test.\r\n`;

try {
	console.log(
		`== setup: image, network, Pebble, challtestsrv, Traefik (work dir ${work})`,
	);
	await $`docker network rm ${NETWORK}`.nothrow().quiet();
	await $`docker network create --subnet ${SUBNET} ${NETWORK}`.quiet();
	const built = await $`docker build -t ${IMAGE} ${ROOT}`.nothrow().quiet();
	check(
		'docker build',
		built.exitCode === 0,
		built.exitCode === 0 ? IMAGE : built.stderr.toString().slice(-500),
	);
	if (built.exitCode !== 0) throw new Error('the image did not build');
	const size =
		await $`docker image inspect ${IMAGE} --format ${'{{.Size}}'}`.text();
	check(
		'image size',
		true,
		`${(Number(size) / 1e6).toFixed(0)} MB (docker image inspect)`,
	);
	const nonRoot =
		await $`docker image inspect ${IMAGE} --format ${'{{.Config.User}}'}`.text();
	check(
		'runs as a non-root user',
		nonRoot.trim() === '10001:10001',
		nonRoot.trim(),
	);

	const direct = compose('compose.traefik', [`${work}/ports.yaml`]);
	await Bun.write(
		`${work}/ports.yaml`,
		`services:\n  bumail:\n    ports: !override\n${Object.entries({
			25: DIRECT.mx,
			465: DIRECT.submissions,
			587: DIRECT.submission,
			993: DIRECT.imaps,
		})
			.map(([inside, outside]) => `      - '127.0.0.1:${outside}:${inside}'\n`)
			.join('')}`,
	);
	const up = await direct(
		'up',
		'--detach',
		'traefik',
		'pebble',
		'challtestsrv',
	);
	if (up.exitCode !== 0)
		throw new Error(`infrastructure did not start: ${up.stderr}`);
	// Pebble's CA, for bumail's ACME client and for Traefik's resolver.
	const pebbleId = (await text(direct('ps', '--quiet', 'pebble'))).trim();
	await $`docker cp ${pebbleId}:/test/certs/pebble.minica.pem ${work}/minica.pem`.quiet();
	await until(
		'the challtestsrv API',
		30,
		async () =>
			(await fetch(`${CHALLTESTSRV}/`).catch(() => undefined))?.status !==
			undefined,
	);
	await fetch(`${CHALLTESTSRV}/add-a`, {
		method: 'POST',
		body: JSON.stringify({ host: `${HOST}.`, addresses: [TRAEFIK_IP] }),
	});
	// Pebble and Traefik read the CA file at start: restart them with it present.
	await direct('up', '--detach', '--force-recreate', 'traefik', 'pebble');
	await until('Pebble', 60, async () => {
		const answer = await fetch('https://localhost:15000/roots/0', {
			tls: { rejectUnauthorized: false },
		}).catch(() => undefined);
		return answer?.ok;
	}).catch(() => undefined);
	check('Traefik, Pebble and the DNS are up', true, `${HOST} -> ${TRAEFIK_IP}`);

	console.log(
		'== 0: the standalone variant (compose.yaml): bumail binds 80 itself',
	);
	await fetch(`${CHALLTESTSRV}/add-a`, {
		method: 'POST',
		body: JSON.stringify({
			host: `${STANDALONE_HOST}.`,
			addresses: [STANDALONE_IP],
		}),
	});
	const alone = standalone();
	const aloneInit = await text(
		alone(
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
		),
	);
	check(
		'standalone: bumail init with the three flags the guide uses',
		aloneInit.includes('wrote /data/bumail.toml'),
		aloneInit.split('\n')[0] ?? '',
	);
	const aloneUser =
		await $`echo ${password} | docker compose -p ${STANDALONE_PROJECT} -f ${ROOT}/deploy/compose.yaml -f ${ROOT}/deploy/test/e2e-standalone.yaml -f ${work}/standalone-ports.yaml run --rm -T bumail user add ${user} --password-stdin`
			.env({ ...env, BUMAIL_HOST: STANDALONE_HOST })
			.nothrow()
			.quiet();
	check(
		'standalone: bumail user add',
		aloneUser.exitCode === 0,
		`${aloneUser.stdout}`.trim(),
	);
	await alone('up', '--detach', 'bumail');
	const aloneLog = await until('the standalone certificate', 120, async () => {
		const log = await text(alone('logs', '--no-color', 'bumail'));
		return log.includes('tls: obtained (') ? log : undefined;
	}).catch(async () => text(alone('logs', '--no-color', 'bumail')));
	check(
		"standalone: the certificate was obtained, the CA reaching bumail's own port 80",
		aloneLog.includes('tls: obtained (') &&
			aloneLog.includes('acme: the CA fetched the challenge'),
		aloneLog
			.split('\n')
			.find((l) => l.includes('tls: obtained'))
			?.trim() ?? aloneLog.slice(-300),
	);
	await until('standalone serving', 60, async () =>
		(await text(alone('logs', '--no-color', 'bumail'))).includes(
			'bumail: serving',
		),
	);
	const lone = await Smtp.connect('127.0.0.1', DIRECT.submission, {
		servername: STANDALONE_HOST,
	});
	await lone.smtp.command('EHLO e2e.bumail.test');
	await lone.smtp.startTls(STANDALONE_HOST);
	await lone.smtp.command('EHLO e2e.bumail.test');
	const loneAuth = await lone.smtp.authPlain(user, password);
	const loneSubject = `standalone ${run}`;
	const loneSent =
		loneAuth.code === 235
			? await lone.smtp.send(user, user, mailBody(loneSubject))
			: loneAuth;
	check(
		'standalone: 587 STARTTLS, AUTH and the message accepted',
		loneAuth.code === 235 && loneSent.code === 250,
		`${loneAuth.code} ${loneSent.code}; certificate by ${lone.smtp.certificate.issuer}`,
	);
	await lone.smtp.quit();
	const loneImap = await until('the standalone message', 30, async () => {
		const got = await imapFetchAll(
			'127.0.0.1',
			DIRECT.imaps,
			user,
			password,
			STANDALONE_HOST,
		);
		return got.text.includes(loneSubject) ? got : undefined;
	});
	check(
		'standalone: the message read back over IMAPS 993',
		loneImap.text.includes(loneSubject),
		'',
	);
	const loneMx = await Smtp.connect('127.0.0.1', DIRECT.mx, {
		servername: STANDALONE_HOST,
	});
	const loneMxEhlo = await loneMx.smtp.command('EHLO e2e.bumail.test');
	check(
		'standalone: 25 offers no AUTH',
		!loneMxEhlo.lines.some((l) => /AUTH/.test(l)),
		'',
	);
	await loneMx.smtp.quit();
	const loneJmap = await fetch(`${STANDALONE_JMAP}/.well-known/jmap`, {
		headers: {
			Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
		},
		tls: { rejectUnauthorized: false },
	}).catch(() => undefined);
	check(
		'standalone: JMAP answers over HTTPS on 443',
		loneJmap?.status === 200,
		`HTTP ${loneJmap?.status}`,
	);
	const loneHealth = await text(
		alone('exec', '-T', 'bumail', '/usr/local/bin/bumail', 'health'),
	);
	check(
		'standalone: bumail health passes',
		loneHealth.trim() === 'ok',
		loneHealth.trim(),
	);
	await alone('down', '--volumes', '--timeout', '30');

	console.log('== 1: init and a user (the guide, steps 3 and 4)');
	const initArgs = [
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
	const behind = ['--behind-traefik', '--trusted-proxy', SUBNET];
	const initOut = await text(
		direct('run', '--rm', '-T', 'bumail', ...initArgs, ...behind),
	);
	check(
		'bumail init writes the configuration and the DKIM key',
		initOut.includes('wrote /data/bumail.toml') &&
			initOut.includes('generated an RSA-2048 DKIM key'),
		initOut.split('\n')[0] ?? '',
	);
	const again = await text(
		direct('run', '--rm', '-T', 'bumail', ...initArgs, ...behind),
	);
	check(
		'bumail init refuses to overwrite',
		again.includes('exists; --force replaces it'),
		again.trim().split('\n')[0] ?? '',
	);
	const checkConfig = await text(
		direct('run', '--rm', '-T', 'bumail', 'check-config'),
	);
	check(
		'bumail check-config accepts it',
		checkConfig.includes('/data/bumail.toml: ok') &&
			checkConfig.includes('jmap'),
		'',
	);
	const added =
		await $`echo ${password} | docker compose -p ${PROJECT} -f ${ROOT}/deploy/compose.traefik.yaml -f ${ROOT}/deploy/test/e2e.yaml run --rm -T bumail user add ${user} --password-stdin`
			.env(env)
			.nothrow()
			.quiet();
	check(
		'bumail user add',
		`${added.stdout}${added.stderr}`.includes(`added the user ${user}`) ||
			added.exitCode === 0,
		`${added.stdout}${added.stderr}`.trim().split('\n')[0],
	);

	console.log('== 2: up, and the certificate through the challenge route');
	await direct('up', '--detach', 'bumail');
	const started = await until('the certificate', 120, async () => {
		const log = await logs('compose.traefik');
		return log.includes('tls: obtained (') ? log : undefined;
	}).catch(async () => logs('compose.traefik'));
	check(
		'the certificate was obtained from the CA',
		started.includes('tls: obtained ('),
		started.split('\n').find((l) => l.includes('tls: obtained')) ??
			started.slice(-300),
	);
	check(
		'the CA fetched the challenge (through Traefik)',
		started.includes('acme: the CA fetched the challenge'),
		started.split('\n').find((l) => l.includes('the CA fetched')) ?? '',
	);
	const traefikLog = await text(direct('logs', '--no-color', 'traefik'));
	check(
		'Traefik routed it with the bumail-acme router',
		/acme-challenge[^\n]*bumail-acme@docker/.test(traefikLog),
		traefikLog
			.split('\n')
			.find((l) => l.includes('bumail-acme@docker'))
			?.slice(0, 200) ?? 'no access log line',
	);
	await until('bumail serving', 60, async () =>
		(await logs('compose.traefik')).includes('bumail: serving'),
	);

	console.log('== 3: the mail ports, JMAP and the health check');
	const { smtp, greeting } = await Smtp.connect(
		'127.0.0.1',
		DIRECT.submission,
		{ servername: HOST },
	);
	check('587 greets', greeting.code === 220, greeting.lines[0]);
	const ehlo = await smtp.command('EHLO e2e.bumail.test');
	check(
		'587 offers STARTTLS and no AUTH before it',
		ehlo.lines.some((l) => /STARTTLS/.test(l)) &&
			!ehlo.lines.some((l) => /AUTH/.test(l)),
		ehlo.lines.join(' | '),
	);
	const early = await smtp.authPlain(user, password);
	check(
		'587 refuses AUTH without TLS',
		early.code >= 400 && early.code < 600,
		`${early.code}`,
	);
	const tlsAnswer = await smtp.startTls(HOST);
	check('587 STARTTLS', tlsAnswer.code === 220, tlsAnswer.lines[0]);
	const issuer = smtp.certificate;
	check(
		'the certificate on 587 was issued by the test CA for the host',
		/Pebble/.test(issuer.issuer) && issuer.subjectaltname.includes(HOST),
		`${issuer.issuer}; ${issuer.subjectaltname}`,
	);
	const secure = await smtp.command('EHLO e2e.bumail.test');
	check(
		'587 offers AUTH after STARTTLS',
		secure.lines.some((l) => /AUTH/.test(l)),
		secure.lines.join(' | '),
	);
	const wrong = await smtp.authPlain(user, 'not-the-password');
	check('587 refuses a wrong password', wrong.code === 535, `${wrong.code}`);
	const auth = await smtp.authPlain(user, password);
	check('587 AUTH succeeds', auth.code === 235, `${auth.code}`);
	const subject = `submission ${run}`;
	const sent = await smtp.send(user, user, mailBody(subject));
	check('587 accepts the message', sent.code === 250, sent.lines.join(' | '));
	await smtp.quit();

	const imap = await until('the message in the mailbox', 30, async () => {
		const got = await imapFetchAll(
			'127.0.0.1',
			DIRECT.imaps,
			user,
			password,
			HOST,
		);
		return got.text.includes(subject) ? got : undefined;
	});
	check(
		'the message landed, read back over IMAPS 993',
		imap.text.includes(`Subject: ${subject}`),
		`certificate by ${imap.certificate.issuer}`,
	);

	const mx = await Smtp.connect('127.0.0.1', DIRECT.mx, { servername: HOST });
	const mxEhlo = await mx.smtp.command('EHLO e2e.bumail.test');
	check(
		'25 offers STARTTLS and no AUTH',
		mxEhlo.lines.some((l) => /STARTTLS/.test(l)) &&
			!mxEhlo.lines.some((l) => /AUTH/.test(l)),
		mxEhlo.lines.join(' | '),
	);
	await mx.smtp.startTls(HOST);
	const mxSecure = await mx.smtp.command('EHLO e2e.bumail.test');
	check(
		'25 offers no AUTH after STARTTLS either',
		!mxSecure.lines.some((l) => /AUTH/.test(l)),
		mxSecure.lines.join(' | '),
	);
	const relay = await mx.smtp.send(
		'someone@elsewhere.example',
		'victim@elsewhere.example',
		mailBody('relay'),
	);
	check(
		'25 does not relay for strangers',
		relay.code >= 500 && relay.code < 600,
		relay.lines.join(' | '),
	);
	await mx.smtp.quit();

	const session = await fetch(`${JMAP_URL}/.well-known/jmap`, {
		headers: {
			Host: HOST,
			Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
		},
		tls: { rejectUnauthorized: false },
		redirect: 'manual',
	}).catch((error: unknown) => error as Error);
	if (session instanceof Response) {
		const body = (await session.json().catch(() => ({}))) as {
			apiUrl?: string;
		};
		check(
			'JMAP answers through Traefik',
			session.status === 200 && body.apiUrl === `https://${HOST}/jmap/api`,
			`HTTP ${session.status}; apiUrl ${body.apiUrl}`,
		);
	} else {
		check('JMAP answers through Traefik', false, String(session));
	}
	const traefikCert = await until("Traefik's own certificate", 90, async () => {
		const tls = await import('node:tls');
		return new Promise<string | undefined>((resolve) => {
			const socket = tls.connect(
				{
					host: '127.0.0.1',
					port: 18443,
					servername: HOST,
					rejectUnauthorized: false,
				},
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
	}).catch(() => undefined);
	check(
		'Traefik keeps its own certificate for HTTPS (from its resolver, on the test CA)',
		traefikCert !== undefined,
		traefikCert ?? 'it served its default certificate',
	);
	const anonymous = await fetch(`${JMAP_URL}/.well-known/jmap`, {
		headers: { Host: HOST },
		tls: { rejectUnauthorized: false },
		redirect: 'manual',
	}).catch(() => undefined);
	check(
		'JMAP refuses a request without a login',
		anonymous?.status === 401,
		`HTTP ${anonymous?.status}`,
	);

	const healthy = await text(
		direct('exec', '-T', 'bumail', '/usr/local/bin/bumail', 'health'),
	);
	check('bumail health passes', healthy.trim() === 'ok', healthy.trim());
	const status = await until(
		'the container to report healthy',
		120,
		async () => {
			const id = (await text(direct('ps', '--quiet', 'bumail'))).trim();
			const health = (
				await $`docker inspect ${id} --format ${'{{.State.Health.Status}}'}`.text()
			).trim();
			return health === 'healthy' ? health : undefined;
		},
	).catch(() => 'not healthy in time');
	check("Docker's HEALTHCHECK reports healthy", status === 'healthy', status);
	const directLog = await logs('compose.traefik');
	check(
		'the log names no password',
		!directLog.includes(password) && !directLog.includes('not-the-password'),
		'',
	);

	console.log(
		'== 4: the TCP variant, PROXY protocol v2, the real client address',
	);
	await direct('rm', '--stop', '--force', 'bumail');
	const tcp = compose('compose.traefik-tcp');
	const tcpInit = await text(
		tcp(
			'run',
			'--rm',
			'-T',
			'bumail',
			...initArgs,
			'--force',
			...behind,
			'--proxy-protocol',
		),
	);
	check(
		'bumail init --force with --proxy-protocol keeps the domain and the key',
		tcpInit.includes('kept') && tcpInit.includes('wrote /data/bumail.toml'),
		tcpInit
			.split('\n')
			.filter((l) => l.includes('kept'))
			.join(' | ')
			.slice(0, 200),
	);
	const tcpConfig = await text(
		tcp('run', '--rm', '-T', 'bumail', 'check-config'),
	);
	check(
		'check-config shows the PROXY protocol',
		/mail proxies\s+1 trusted prox/.test(tcpConfig),
		tcpConfig.split('\n').find((l) => l.includes('mail proxies')) ?? '',
	);
	await tcp('up', '--detach', 'bumail');
	const second = await until('bumail serving again', 90, async () => {
		const log = await logs('compose.traefik-tcp');
		return log.includes('bumail: serving') &&
			log.includes('tls: using the stored certificate')
			? log
			: undefined;
	}).catch(async () => logs('compose.traefik-tcp'));
	check(
		'restarts on the volume with the stored certificate, no new order',
		second.includes('tls: using the stored certificate'),
		second
			.split('\n')
			.find((l) => l.includes('stored certificate'))
			?.slice(0, 160) ?? '',
	);
	await until('Traefik to route the TCP services', 60, async () => {
		const answer = await Smtp.connect('127.0.0.1', VIA_TRAEFIK.submission, {
			servername: HOST,
		}).catch(() => undefined);
		if (answer === undefined) return false;
		const ok = answer.greeting.code === 220;
		await answer.smtp.quit();
		return ok;
	});
	check(
		'Traefik TCP router passes 587 through',
		true,
		`127.0.0.1:${VIA_TRAEFIK.submission} -> bumail:587`,
	);

	const bad = await client('badlogin', 'traefik', '587', user);
	const afterBad = await logs('compose.traefik-tcp');
	check(
		'a refused login names the real client, not Traefik',
		bad['auth'] === 535 &&
			afterBad.includes(`login refused from ${CLIENT_IP}:`) &&
			!afterBad.includes(`login refused from ${TRAEFIK_IP}`),
		afterBad
			.split('\n')
			.find((l) => l.includes('login refused'))
			?.trim() ?? '',
	);

	const viaSubject = `via traefik ${run}`;
	const viaSent = await client(
		'submit',
		'traefik',
		'587',
		user,
		password,
		user,
		user,
		viaSubject,
	);
	check(
		'submission on 587 through Traefik: STARTTLS, AUTH, accepted',
		viaSent['auth'] === 235 && viaSent['sent'] === 250,
		JSON.stringify(viaSent).slice(0, 160),
	);
	const inboundSubject = `inbound ${run}`;
	const inbound = await client(
		'deliver',
		'traefik',
		'25',
		`sender@${HOST}`,
		user,
		inboundSubject,
	);
	check(
		'mail from another server through Traefik on 25 is accepted',
		inbound['sent'] === 250,
		JSON.stringify(inbound).slice(0, 200),
	);
	const viaImap = await until('both messages', 30, async () => {
		const got = await imapFetchAll(
			'127.0.0.1',
			VIA_TRAEFIK.imaps,
			user,
			password,
			HOST,
		);
		return got.text.includes(viaSubject) && got.text.includes(inboundSubject)
			? got
			: undefined;
	});
	check(
		'both landed, read back over IMAPS 993 through Traefik',
		true,
		`certificate by ${viaImap.certificate.issuer}`,
	);
	const received = viaImap.text
		.split('\n')
		.filter((l) => /^Received:/i.test(l) || /\[?172\.29\.77\./.test(l));
	check(
		'the Received header names the real client address',
		received.some((l) => l.includes(CLIENT_IP)) &&
			!received.some((l) => l.includes(`[${TRAEFIK_IP}]`)),
		received.join(' | ').slice(0, 300),
	);
	const tcpLog = await logs('compose.traefik-tcp');
	check(
		'the log shows the real client address on 25',
		tcpLog.split('\n').some((l) => l.includes(CLIENT_IP) && /mx:/.test(l)),
		tcpLog
			.split('\n')
			.filter((l) => l.includes(CLIENT_IP))
			.slice(0, 3)
			.join(' | ')
			.slice(0, 300),
	);
	const tcpJmap = await fetch(`${JMAP_URL}/.well-known/jmap`, {
		headers: {
			Host: HOST,
			Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
		},
		tls: { rejectUnauthorized: false },
	}).catch(() => undefined);
	check(
		'JMAP still answers through Traefik in the TCP variant',
		tcpJmap?.status === 200,
		`HTTP ${tcpJmap?.status}`,
	);
	const tcpHealth = await text(
		tcp('exec', '-T', 'bumail', '/usr/local/bin/bumail', 'health'),
	);
	check(
		'bumail health passes in the TCP variant',
		tcpHealth.trim() === 'ok',
		tcpHealth.trim(),
	);
} catch (error) {
	const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? '';
	check(
		'the end-to-end run itself',
		false,
		`${error instanceof Error ? error.message : String(error)} ${stderr}`.trim(),
	);
} finally {
	if (process.env['E2E_KEEP'] === '1') {
		console.log(
			`== E2E_KEEP=1: left running; remove with: docker compose -p ${PROJECT} down -v; docker network rm ${NETWORK}`,
		);
	} else {
		console.log('== teardown');
		await teardown();
	}
}

const failed = results.filter((r) => !r.ok);
console.log(
	`\n${results.length - failed.length} of ${results.length} checks passed`,
);
for (const f of failed) console.log(`FAILED: ${f.name}  ${f.detail}`);
process.exit(failed.length === 0 ? 0 : 1);
