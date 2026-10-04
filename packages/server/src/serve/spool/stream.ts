/** `prefix`, then the spooled file from `start`, as one stream. */
export function spooledStream(
	prefix: Uint8Array,
	file: string,
	start: number,
): ReadableStream<Uint8Array> {
	let rest: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let sentPrefix = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!sentPrefix) {
				sentPrefix = true;
				if (prefix.length > 0) {
					controller.enqueue(prefix);
					return;
				}
			}
			rest ??= Bun.file(file).slice(start).stream().getReader();
			const { done, value } = await rest.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		async cancel(reason) {
			await rest?.cancel(reason);
		},
	});
}
