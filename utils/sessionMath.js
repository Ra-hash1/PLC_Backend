// utils/sessionMath.js
// Pure session calculation utilities — no side effects, safe to unit-test.

/**
 * Seconds elapsed since a session started.
 * @param {Date}   startAt  – when the session began
 * @param {number} now      – current timestamp ms (defaults to Date.now())
 * @returns {number}        – non-negative integer
 */
function computeSessionRuntimeSeconds(startAt, now = Date.now()) {
  return Math.max(0, Math.floor((now - startAt.getTime()) / 1000));
}

/**
 * Pouches produced in the current session.
 * Handles counter wrap/reset: if current < last, treats current as the delta.
 * @param {number} currentCounter – latest raw PLC counter value
 * @param {number} lastCounter    – counter value at session start
 * @returns {number}
 */
function computeSessionPouches(currentCounter, lastCounter) {
  if (currentCounter < lastCounter) {
    // Counter was reset or wrapped — use current value as the production delta
    return Math.max(0, currentCounter);
  }
  return Math.max(0, currentCounter - lastCounter);
}

/**
 * Session-average production rate in pouches per minute.
 * Returns 0 if sessionRuntimeSeconds is 0 to avoid division by zero.
 * @param {number} sessionPouches
 * @param {number} sessionRuntimeSeconds
 * @returns {number}  rounded to 2 decimal places
 */
function computeProductionRatePpm(sessionPouches, sessionRuntimeSeconds) {
  if (sessionRuntimeSeconds <= 0) return 0;
  const ppm = sessionPouches / (sessionRuntimeSeconds / 60);
  return Math.round(ppm * 100) / 100;
}

module.exports = {
  computeSessionRuntimeSeconds,
  computeSessionPouches,
  computeProductionRatePpm,
};
