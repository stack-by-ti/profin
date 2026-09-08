const UMAG_BASE_URL = 'https://api.umag.kz/rest/cabinet';
const UMAG_HEADERS = {
  'api-ver': '1.4',
  'client-ver': 'angular_cabinet_20.1.3',
  Accept: 'application/json',
};
const UMAG_REQUEST_TIMEOUT_MS = 15_000;

export class UmagError extends Error {
  constructor(message, { code = 'UMAG_ERROR', status = 502 } = {}) {
    super(message);
    this.name = 'UmagError';
    this.code = code;
    this.status = status;
  }
}

export function assertValidMonth(month) {
  const match = String(month ?? '').match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new UmagError('Month must use YYYY-MM format.', {
      code: 'INVALID_MONTH',
      status: 400,
    });
  }

  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (year < 2000 || year > 9999 || monthNumber < 1 || monthNumber > 12) {
    throw new UmagError('Month must use YYYY-MM format.', {
      code: 'INVALID_MONTH',
      status: 400,
    });
  }

  return { year, monthNumber };
}

export function monthToAlmatyRange(month) {
  const { year, monthNumber } = assertValidMonth(month);
  const almatyOffsetMs = 5 * 60 * 60 * 1000;
  const fromTime = Date.UTC(year, monthNumber - 1, 1) - almatyOffsetMs;
  const toTime = Date.UTC(year, monthNumber, 1) - almatyOffsetMs - 1;

  return { fromTime, toTime };
}

export function dateRangeToAlmatyRange(fromDate, toDate) {
  const parseDate = (value, field) => {
    const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const date = match
      ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      : null;
    if (!date
      || date.getUTCFullYear() !== Number(match[1])
      || date.getUTCMonth() !== Number(match[2]) - 1
      || date.getUTCDate() !== Number(match[3])) {
      throw new UmagError(`${field} must use YYYY-MM-DD format.`, {
        code: 'INVALID_DATE_RANGE',
        status: 400,
      });
    }
    return date;
  };

  const from = parseDate(fromDate, 'fromDate');
  const to = parseDate(toDate, 'toDate');
  if (from > to) {
    throw new UmagError('fromDate must not be later than toDate.', {
      code: 'INVALID_DATE_RANGE',
      status: 400,
    });
  }

  const almatyOffsetMs = 5 * 60 * 60 * 1000;
  return {
    fromTime: from.getTime() - almatyOffsetMs,
    toTime: to.getTime() + 24 * 60 * 60 * 1000 - almatyOffsetMs - 1,
  };
}

export function calculateGrossMargin(profit, revenue) {
  const normalizedRevenue = Number(revenue);
  if (!Number.isFinite(normalizedRevenue) || normalizedRevenue === 0) return 0;

  const normalizedProfit = Number(profit);
  if (!Number.isFinite(normalizedProfit)) return 0;

  return Math.round((normalizedProfit / normalizedRevenue) * 10000) / 100;
}

function requiredNumber(value, field) {
  if (value === null || value === undefined || value === '') {
    throw new UmagError(`UMAG report is missing ${field}.`, {
      code: 'INVALID_UMAG_RESPONSE',
    });
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new UmagError(`UMAG report contains invalid ${field}.`, {
      code: 'INVALID_UMAG_RESPONSE',
    });
  }

  return number;
}

export function normalizeUmagReport(month, response) {
  assertValidMonth(month);
  const report = response?.profitReport;
  if (!report || typeof report !== 'object') {
    throw new UmagError('UMAG report does not contain profitReport.', {
      code: 'INVALID_UMAG_RESPONSE',
    });
  }

  const revenue = requiredNumber(report.revenueAmount, 'revenueAmount');
  const cost = requiredNumber(report.arrivalAmount, 'arrivalAmount');
  const grossProfit = requiredNumber(report.profit, 'profit');

  return {
    month,
    revenue,
    cost,
    grossProfit,
    grossMargin: calculateGrossMargin(grossProfit, revenue),
  };
}

export function assertUmagConfigured(env = process.env) {
  const login = env.UMAG_LOGIN;
  const password = env.UMAG_PASSWORD;
  const storeId = env.UMAG_STORE_ID;

  if (!login || !password || !storeId) {
    throw new UmagError(
      'UMAG integration is not configured. Set UMAG_LOGIN, UMAG_PASSWORD and UMAG_STORE_ID.',
      { code: 'UMAG_NOT_CONFIGURED', status: 503 },
    );
  }

  return { login, password, storeId };
}

async function readJson(response, operation) {
  try {
    return await response.json();
  } catch {
    throw new UmagError(`UMAG ${operation} returned invalid JSON.`, {
      code: 'INVALID_UMAG_RESPONSE',
    });
  }
}

async function signIn(fetchImpl, config) {
  let response;
  try {
    response = await fetchImpl(`${UMAG_BASE_URL}/org/login/signin`, {
      signal: AbortSignal.timeout(UMAG_REQUEST_TIMEOUT_MS),
      headers: {
        ...UMAG_HEADERS,
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${config.login}:${config.password}`).toString('base64')}`,
      },
    });
  } catch {
    throw new UmagError('UMAG login endpoint is unavailable.', {
      code: 'UMAG_LOGIN_UNAVAILABLE',
    });
  }

  if (!response.ok) {
    throw new UmagError(`UMAG authentication failed with status ${response.status}.`, {
      code: 'UMAG_AUTH_FAILED',
      status: response.status === 401 ? 502 : 502,
    });
  }

  const data = await readJson(response, 'login');
  if (!data?.sessionToken || typeof data.sessionToken !== 'string') {
    throw new UmagError('UMAG authentication response has no sessionToken.', {
      code: 'UMAG_SESSION_TOKEN_MISSING',
    });
  }

  return data.sessionToken;
}

async function requestReport(fetchImpl, config, range, sessionToken) {
  const { fromTime, toTime } = range;
  const query = new URLSearchParams({
    fromTime: String(fromTime),
    toTime: String(toTime),
    storeId: String(config.storeId),
  });

  let response;
  try {
    response = await fetchImpl(`${UMAG_BASE_URL}/report/profit-and-loss?${query}`, {
      signal: AbortSignal.timeout(UMAG_REQUEST_TIMEOUT_MS),
      headers: {
        ...UMAG_HEADERS,
        Authorization: sessionToken,
      },
    });
  } catch {
    throw new UmagError('UMAG report endpoint is unavailable.', {
      code: 'UMAG_REPORT_UNAVAILABLE',
    });
  }

  if (response.status === 401) return { unauthorized: true };
  if (!response.ok) {
    throw new UmagError(`UMAG report request failed with status ${response.status}.`, {
      code: 'UMAG_REPORT_FAILED',
    });
  }

  return { data: await readJson(response, 'report') };
}

export async function getUmagMetrics(month, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  assertValidMonth(month);
  const range = monthToAlmatyRange(month);
  const config = assertUmagConfigured(env);
  let sessionToken = await signIn(fetchImpl, config);
  let report = await requestReport(fetchImpl, config, range, sessionToken);

  if (report.unauthorized) {
    sessionToken = await signIn(fetchImpl, config);
    report = await requestReport(fetchImpl, config, range, sessionToken);
  }

  if (report.unauthorized) {
    throw new UmagError('UMAG report authorization failed after one retry.', {
      code: 'UMAG_REPORT_UNAUTHORIZED',
    });
  }

  return normalizeUmagReport(month, report.data);
}

export async function getUmagMetricsForRange(fromDate, toDate, {
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const range = dateRangeToAlmatyRange(fromDate, toDate);
  const config = assertUmagConfigured(env);
  let sessionToken = await signIn(fetchImpl, config);
  let report = await requestReport(fetchImpl, config, range, sessionToken);

  if (report.unauthorized) {
    sessionToken = await signIn(fetchImpl, config);
    report = await requestReport(fetchImpl, config, range, sessionToken);
  }

  if (report.unauthorized) {
    throw new UmagError('UMAG report authorization failed after one retry.', {
      code: 'UMAG_REPORT_UNAUTHORIZED',
    });
  }

  const { month: _month, ...metrics } = normalizeUmagReport(fromDate.slice(0, 7), report.data);
  return { ...metrics, fromDate, toDate };
}
