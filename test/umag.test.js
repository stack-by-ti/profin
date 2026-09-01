import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateGrossMargin,
  getUmagMetrics,
  monthToAlmatyRange,
  normalizeUmagReport,
} from '../src/umag.js';

const sampleReport = {
  profitReport: {
    revenueAmount: 10_302_575,
    arrivalAmount: 7_415_035.24,
    profit: 2_887_539.76,
  },
};

test('converts YYYY-MM to full month boundaries in Asia/Almaty', () => {
  assert.deepEqual(monthToAlmatyRange('2026-08'), {
    fromTime: 1_785_524_400_000,
    toTime: 1_788_202_799_999,
  });
});

test('converts another YYYY-MM value without UTC date drift', () => {
  assert.deepEqual(monthToAlmatyRange('2024-02'), {
    fromTime: Date.UTC(2024, 0, 31, 19),
    toTime: Date.UTC(2024, 1, 29, 18, 59, 59, 999),
  });
});

test('rejects invalid month input', () => {
  assert.throws(() => monthToAlmatyRange('2026-13'), /YYYY-MM/);
  assert.throws(() => monthToAlmatyRange('август'), /YYYY-MM/);
  assert.throws(() => monthToAlmatyRange(''), /YYYY-MM/);
});

test('calculates gross margin rounded to two decimals', () => {
  assert.equal(calculateGrossMargin(2_887_539.76, 10_302_575), 28.03);
});

test('returns zero margin when revenue is zero', () => {
  assert.equal(calculateGrossMargin(100, 0), 0);
});

test('maps UMAG response to normalized metrics', () => {
  assert.deepEqual(normalizeUmagReport('2026-08', sampleReport), {
    month: '2026-08',
    revenue: 10_302_575,
    cost: 7_415_035.24,
    grossProfit: 2_887_539.76,
    grossMargin: 28.03,
  });
});

test('rejects a report with missing revenue', () => {
  assert.throws(
    () => normalizeUmagReport('2026-08', {
      profitReport: { arrivalAmount: 10, profit: 5 },
    }),
    /revenueAmount/,
  );
});

test('reauthenticates once when report responds with 401', async () => {
  const requests = [];
  const responses = [
    { ok: true, status: 200, json: async () => ({ sessionToken: 'first-token' }) },
    { ok: false, status: 401, json: async () => ({}) },
    { ok: true, status: 200, json: async () => ({ sessionToken: 'second-token' }) },
    { ok: true, status: 200, json: async () => sampleReport },
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  };

  const result = await getUmagMetrics('2026-08', {
    env: { UMAG_LOGIN: 'login', UMAG_PASSWORD: 'password', UMAG_STORE_ID: '49924' },
    fetchImpl,
  });

  assert.equal(result.grossMargin, 28.03);
  assert.equal(requests.length, 4);
  assert.equal(requests[1].options.headers.Authorization, 'first-token');
  assert.equal(requests[3].options.headers.Authorization, 'second-token');
  assert.ok(!requests[3].options.headers.Authorization.startsWith('Bearer '));
});

test('returns a clear configuration error without making an HTTP request', async () => {
  let requestCount = 0;

  await assert.rejects(
    getUmagMetrics('2026-08', {
      env: {},
      fetchImpl: async () => {
        requestCount += 1;
      },
    }),
    (error) => error.code === 'UMAG_NOT_CONFIGURED' && error.status === 503,
  );
  assert.equal(requestCount, 0);
});
