/** Where the server writes its log: one line per call, without its line end. */
export type Log = (line: string) => void;
