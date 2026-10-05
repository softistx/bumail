/**
 * The e2e's context: names, addresses and ports unique to this run (so two
 * runs never clobber each other), and the constants every phase shares.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePorts, type Report } from './check';

export const ROOT = new URL('../..', import.meta.url).pathname.replace(
	/\/$/,
	'',
);
export const DOMAIN = 'bumail.test';
export const HOST = 'mail.bumail.test';
export const STANDALONE_HOST = 'standalone.bumail.test';
export const PEBBLE_DIRECTORY = 'https://pebble:14000/dir';
export const CLIENT_IMAGE =
	'oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895';

export interface Context {
	readonly report: Report;
	readonly suffix: string;
	/** The project of the Traefik variants and of the infrastructure. */
	readonly project: string;
	readonly standaloneProject: string;
	readonly network: string;
	/** `172.29.<n>.0/24`, picked for this run. */
	readonly subnet: string;
	readonly ips: {
		traefik: string;
		challtestsrv: string;
		standalone: string;
		client: string;
	};
	/** Host ports on 127.0.0.1, free when chosen. */
	readonly ports: {
		mx: number;
		submissions: number;
		submission: number;
		imaps: number;
		jmapDirect: number;
		jmapTraefik: number;
		tcpMx: number;
		tcpSubmissions: number;
		tcpSubmission: number;
		tcpImaps: number;
		challtestsrv: number;
	};
	readonly image: string;
	readonly work: string;
	readonly password: string;
	readonly user: string;
	/** Tags this run's messages. */
	readonly run: string;
	readonly env: Record<string, string | undefined>;
}

/** The host ports of this run, each free on 127.0.0.1 when chosen. */
const PORT_NAMES = [
	'mx',
	'submissions',
	'submission',
	'imaps',
	'jmapDirect',
	'jmapTraefik',
	'tcpMx',
	'tcpSubmissions',
	'tcpSubmission',
	'tcpImaps',
	'challtestsrv',
] as const;

function pickPorts(): Context['ports'] {
	const free = freePorts(PORT_NAMES.length);
	return Object.fromEntries(
		PORT_NAMES.map((name, i) => [name, free[i]]),
	) as Context['ports'];
}

/** The environment the compose files read: `${E2E_...}` and the deploy files' own. */
function composeEnv(
	ctx: Pick<Context, 'network' | 'image' | 'work' | 'ips' | 'ports'>,
): Record<string, string | undefined> {
	const { network, image, work, ips, ports } = ctx;
	return {
		...process.env,
		COMPOSE_FILE: '',
		TRAEFIK_NETWORK: network,
		BUMAIL_HOST: HOST,
		// The compose files pull ghcr.io/softistx/bumail:$BUMAIL_VERSION; this run
		// builds that name locally, so nothing is pulled.
		BUMAIL_VERSION: image.slice(image.lastIndexOf(':') + 1),
		E2E_DIR: work,
		E2E_NETWORK: network,
		E2E_IP_TRAEFIK: ips.traefik,
		E2E_IP_CHALLTESTSRV: ips.challtestsrv,
		E2E_IP_STANDALONE: ips.standalone,
		E2E_PORT_HTTPS: String(ports.jmapTraefik),
		E2E_PORT_SMTP: String(ports.tcpMx),
		E2E_PORT_SUBMISSIONS: String(ports.tcpSubmissions),
		E2E_PORT_SUBMISSION: String(ports.tcpSubmission),
		E2E_PORT_IMAPS: String(ports.tcpImaps),
		E2E_PORT_CHALLTESTSRV: String(ports.challtestsrv),
	};
}

export function createContext(report: Report): Context {
	const suffix = crypto.randomUUID().slice(0, 6);
	const prefix = `172.29.${20 + Math.floor(Math.random() * 200)}`;
	const network = `bumail-e2e-proxy-${suffix}`;
	const project = `bumail-e2e-docker-${suffix}`;
	const image = `ghcr.io/softistx/bumail:e2e-docker-${suffix}`;
	const work = mkdtempSync(join(tmpdir(), 'bumail-e2e-'));
	const ips = {
		traefik: `${prefix}.200`,
		challtestsrv: `${prefix}.250`,
		standalone: `${prefix}.150`,
		client: `${prefix}.99`,
	};
	const ports = pickPorts();
	return {
		report,
		suffix,
		project,
		standaloneProject: `${project}-standalone`,
		network,
		subnet: `${prefix}.0/24`,
		ips,
		ports,
		image,
		work,
		password: `e2e-${crypto.randomUUID().slice(0, 12)}`,
		user: `alice@${DOMAIN}`,
		run: crypto.randomUUID().slice(0, 8),
		env: composeEnv({ network, image, work, ips, ports }),
	};
}
