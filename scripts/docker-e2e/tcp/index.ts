/** Phase 4: `deploy/compose.traefik-tcp.yaml`. */
import type { Context } from '../context';
import { certificate } from './certificate';
import { init } from './init';
import { ports } from './ports';

export async function tcpVariant(ctx: Context): Promise<void> {
	await init(ctx);
	await certificate(ctx);
	await ports(ctx);
}
