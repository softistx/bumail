import { describeMailStore } from '../contract/mail-store.fixtures';
import { describePostgres, temporaryStores } from './databases.fixtures';

describePostgres('PostgresMailStore', (url) => {
	const { create } = temporaryStores(url);
	describeMailStore(
		'PostgresMailStore',
		() => create(),
		(maxTombstones) => create({ maxTombstones }),
	);
});
