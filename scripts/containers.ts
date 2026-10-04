/**
 * What `postgres.ts` and `redis.ts` share: a throwaway container for the
 * specs of a store on a server, started (or reused) in Docker, published
 * on loopback only.
 */

/** The port on 127.0.0.1, from `variable` in the environment or `fallback`. */
export function portFrom(
	variable: string,
	value: string | undefined,
	fallback: number,
): number {
	const port = Number(value ?? fallback);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`${variable} must be a port, not ${value}`);
	}
	return port;
}

/** What `docker inspect` said of the container: running or not, and its published port. */
export function containerOf(out: string): { running: boolean; port: number } {
	const [running, port] = out.trim().split(' ');
	return { running: running === 'true', port: Number(port ?? 0) };
}

export function docker(
	args: string[],
	stderr: 'inherit' | 'ignore' = 'inherit',
): { ok: boolean; out: string } {
	const run = Bun.spawnSync(args, { stderr });
	return { ok: run.exitCode === 0, out: run.stdout.toString().trim() };
}

export interface Container {
	/** Its name, as `docker` knows it. */
	readonly name: string;
	/** The port it is published on, or must be. */
	readonly port: number;
	/** `docker run` for a new one. */
	readonly runArgs: string[];
	/** The `bun run` script, and the variable that sets the port, for the error that names them. */
	readonly script: string;
	readonly portVariable: string;
}

/** Starts the container, or the stopped one, unless it runs already. */
export function start({
	name,
	port,
	runArgs,
	script,
	portVariable,
}: Container): void {
	// Not there yet is an answer, not an error.
	const state = docker(
		[
			'docker',
			'inspect',
			'--format',
			'{{.State.Running}} {{range .HostConfig.PortBindings}}{{range .}}{{.HostPort}}{{end}}{{end}}',
			name,
		],
		'ignore',
	);
	const { running, port: published } = containerOf(state.out);
	if (state.ok && published !== port) {
		throw new Error(
			`${name} exists on port ${published || 'none'}, not ${port}: run \`bun run ${script} stop\` first, or set ${portVariable}=${published}`,
		);
	}
	if (running) return;
	const started = state.ok
		? docker(['docker', 'start', name])
		: docker(runArgs);
	if (!started.ok) throw new Error(`docker could not start ${name}`);
}

/**
 * Runs `main`, a container's start: removes the container when the
 * script is given `stop`; otherwise starts it, waits until it answers and
 * prints the `export` line the specs read.
 */
export async function main(
	container: Container,
	ready: () => Promise<void>,
	exportLine: string,
): Promise<void> {
	if (process.argv[2] === 'stop') {
		docker(['docker', 'rm', '--force', container.name]);
		return;
	}
	try {
		start(container);
		await ready();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
	console.log(exportLine);
}
