import type { MailStore } from '@bumail/store';

/**
 * `store`, each call that answers a promise kept in `pending` until it
 * settles: what IMAP and the MX ask of the store, so a stop waits for
 * the calls under way before it closes the store under them.
 */
export function trackedStore(
	store: MailStore,
	pending: Set<Promise<unknown>>,
): MailStore {
	return new Proxy(store, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target);
			if (typeof value !== 'function') return value;
			return (...args: unknown[]) => {
				const result: unknown = value.apply(target, args);
				if (result instanceof Promise) {
					pending.add(result);
					void result.finally(() => pending.delete(result)).catch(() => {});
				}
				return result;
			};
		},
	});
}
