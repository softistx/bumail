import { reply } from '../protocol/reply';
import { type Connection, emptyTransaction } from './connection';
import type { ReceivedMessage } from './options';
import { receivedField } from './received';

/** The end of DATA: refuse what breaks a rule, else hand the message to `onData`. */
export async function finishData(connection: Connection): Promise<void> {
	const reader = connection.reader;
	const chunks = connection.content;
	connection.reader = undefined;
	connection.content = [];
	const transaction = connection.state.transaction;
	connection.state.transaction = emptyTransaction();
	if (!reader) return;

	if (reader.size > connection.settings.maxMessageSize) {
		connection.send(reply(552, '5.3.4', 'Message too big for system'));
		return;
	}
	if (reader.bareLineBreaks > 0) {
		// A bare CR or LF is how SMTP smuggling hides a second message.
		connection.send(
			reply(550, '5.6.11', 'Bare CR or LF is not allowed in a message'),
		);
		return;
	}

	const id = crypto.getRandomValues(new Uint8Array(10)).toHex();
	const received = new TextEncoder().encode(
		receivedField(connection, transaction.to, id),
	);
	const content = new Uint8Array(received.length + reader.size);
	content.set(received, 0);
	let offset = received.length;
	for (const chunk of chunks) {
		content.set(chunk, offset);
		offset += chunk.length;
	}
	const message: ReceivedMessage = {
		id,
		envelope: {
			from: transaction.from ?? '',
			to: [...transaction.to],
			smtputf8: transaction.smtputf8,
			body: transaction.body,
		},
		content,
	};
	const options = connection.settings.options;
	const refused = await connection.hook(() =>
		options.onData(message, connection.session),
	);
	connection.send(refused ?? reply(250, '2.0.0', `OK queued as ${id}`));
}
