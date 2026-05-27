// tests/utils/sessionMath.test.js
const {
  computeSessionRuntimeSeconds,
  computeSessionPouches,
  computeProductionRatePpm,
} = require('../../utils/sessionMath');

describe('computeSessionRuntimeSeconds', () => {
  test('returns correct integer seconds for elapsed time', () => {
    const startAt = new Date(1000);   // 1 s into epoch
    const now     = 61_000;           // 61 s into epoch
    expect(computeSessionRuntimeSeconds(startAt, now)).toBe(60);
  });

  test('returns 0 when now is before startAt', () => {
    const startAt = new Date(5000);
    expect(computeSessionRuntimeSeconds(startAt, 3000)).toBe(0);
  });

  test('truncates fractional seconds — does not round up', () => {
    const startAt = new Date(0);
    expect(computeSessionRuntimeSeconds(startAt, 1999)).toBe(1);
  });
});

describe('computeSessionPouches', () => {
  test('normal increment', () => {
    expect(computeSessionPouches(150, 100)).toBe(50);
  });

  test('returns 0 when counters are equal', () => {
    expect(computeSessionPouches(100, 100)).toBe(0);
  });

  test('counter reset/wrap: current < last → uses current as delta', () => {
    expect(computeSessionPouches(20, 9000)).toBe(20);
  });

  test('never returns negative', () => {
    expect(computeSessionPouches(0, 0)).toBe(0);
  });
});

describe('computeProductionRatePpm', () => {
  test('60 pouches in 60 s = 60.00 ppm', () => {
    expect(computeProductionRatePpm(60, 60)).toBe(60);
  });

  test('returns 0 when sessionRuntimeSeconds is 0', () => {
    expect(computeProductionRatePpm(100, 0)).toBe(0);
  });

  test('200 pouches in 60 s = 200.00 ppm', () => {
    expect(computeProductionRatePpm(200, 60)).toBe(200);
  });

  test('fractional result rounded to 2 decimal places', () => {
    // 1 pouch / (7/60) min ≈ 8.57 ppm
    expect(computeProductionRatePpm(1, 7)).toBeCloseTo(8.57, 1);
  });

  test('returns 0 for negative sessionPouches (defensive guard)', () => {
    expect(computeProductionRatePpm(-5, 60)).toBe(0);
  });
});
