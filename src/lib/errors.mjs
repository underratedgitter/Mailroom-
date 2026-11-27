/**
 * Shared error-narrowing and HTTP error helpers.
 * @typedef {Error & { status?: number, code?: string }} HttpError
 */

/**
 * Extract a human-readable message from an unknown thrown value.
 * @param {unknown} err
 * @returns {string}
 */
export const errMsg = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Return the string `.code` property from an error-like object, if present.
 * @param {unknown} err
 * @returns {string | undefined}
 */
export const errCode = (err) => (
  err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined
);

/**
 * Return the numeric `.status` property from an error-like object, if present.
 * @param {unknown} err
 * @returns {number | undefined}
 */
export const errStatus = (err) => (
  err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
    ? err.status
    : undefined
);

/**
 * Create an Error tagged with an HTTP status code.
 * @param {number} status
 * @param {string} message
 * @returns {HttpError}
 */
export const httpError = (status, message) => Object.assign(new Error(message), { status });

/** @param {string} message @returns {HttpError} */
export const badRequest = (message) => httpError(400, message);

/** @param {string} message @returns {HttpError} */
export const forbidden = (message) => httpError(403, message);

/** @param {string} message @returns {HttpError} */
export const conflict = (message) => httpError(409, message);
