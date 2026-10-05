/** Phases 1 to 3: `deploy/compose.traefik.yaml`. */
import type { Context } from '../context';
import { certificate } from './certificate';
import { init } from './init';
import { ports } from './ports';

export async function traefikVariant(ctx: Context): Promise<void> {
	await init(ctx);
	await certificate(ctx);
	await ports(ctx);
}
