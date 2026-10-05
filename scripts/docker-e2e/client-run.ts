import { CLIENT_IMAGE, type Context, HOST, inNetwork, ROOT } from './setup';

/** Runs `client.ts` in a container at the client address of this run; answers its JSON line. */
export async function client(
	ctx: Context,
	...args: string[]
): Promise<Record<string, unknown>> {
	const out = await inNetwork(
		ctx,
		[
			'-v',
			`${ROOT}/scripts/docker-e2e:/e2e:ro`,
			'-e',
			`E2E_HOSTNAME=${HOST}`,
			CLIENT_IMAGE,
			'bun',
			'/e2e/client.ts',
			...args,
		],
		ctx.ips.client,
	);
	const last = out.stdout.toString().trim().split('\n').pop() ?? '';
	try {
		return JSON.parse(last);
	} catch {
		throw new Error(`the client said: ${out.stdout}${out.stderr}`);
	}
}
