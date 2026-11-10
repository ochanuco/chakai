export type Failure = {
	status: 400 | 401 | 403 | 404 | 409 | 415;
	code: string;
	message: string;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = (
	status: Failure["status"],
	code: string,
	message: string,
): { ok: false; error: Failure } => ({
	ok: false,
	error: { status, code, message },
});
