// Result: an explicit success-or-error value, so domain functions never
// throw on illegal input (P3-06 design constraint 4). The shape matches the
// parse results of @bricx/ids on `ok` and `value`.
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => Object.freeze({ ok: true, value });

export const err = <E>(error: E): Err<E> => Object.freeze({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;

export const isErr = <T, E>(result: Result<T, E>): result is Err<E> =>
  !result.ok;

/** Applies `f` to a value; an error passes through as the same object. */
export const map = <T, U, E>(
  result: Result<T, E>,
  f: (value: T) => U,
): Result<U, E> => (result.ok ? ok(f(result.value)) : result);

/** Applies `f` to an error; a value passes through as the same object. */
export const mapErr = <T, E, F>(
  result: Result<T, E>,
  f: (error: E) => F,
): Result<T, F> => (result.ok ? result : err(f(result.error)));

/** Chains a step that may fail; the first error stops the chain. */
export const andThen = <T, U, E>(
  result: Result<T, E>,
  f: (value: T) => Result<U, E>,
): Result<U, E> => (result.ok ? f(result.value) : result);
