import 'dotenv/config';

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { drive_v3 } from 'googleapis/build/src/apis/drive/v3.js';
import { sheets_v4 } from 'googleapis/build/src/apis/sheets/v4.js';

import {
  groupProductsByQuantity,
  normalizeProductName,
} from './product-ranking.js';
import {
  assertUmagConfigured,
  assertValidMonth,
  getUmagMetrics,
  UmagError,
} from './umag.js';

const PORT = Number(process.env.PORT || 3000);
const TOKEN_DIR = path.resolve('.tokens');
const TOKEN_PATH = path.join(TOKEN_DIR, 'google-oauth-token.json');

const requiredEnv = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

const scopes = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

const app = express();
app.use(express.json());
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID
  || '1DGfiNVJ_ASuua9FH3o4zYOyd7LjPdLgbXAWV8QtPI88';
const SALES_SHEET_TITLE = process.env.GOOGLE_SALES_SHEET_TITLE || 'Продажи';
const SHEETS_SYNC_INTERVAL_MS = Math.max(
  Number(process.env.SHEETS_SYNC_INTERVAL_MS || 5 * 60 * 1000),
  30 * 1000,
);
const sheetsCache = {
  business: null,
  sales: null,
  updatedAt: null,
  refreshPromise: null,
  lastError: null,
};
const driveFileFields = [
  'id',
  'name',
  'mimeType',
  'size',
  'modifiedTime',
  'owners(displayName,emailAddress)',
  'webViewLink',
].join(',');

async function saveToken(tokens) {
  await fs.mkdir(TOKEN_DIR, { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function loadToken() {
  const raw = await fs.readFile(TOKEN_PATH, 'utf8');
  return JSON.parse(raw);
}

async function getAuthenticatedClient() {
  const tokens = await loadToken();
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

function createOAuthState() {
  const payload = `${Date.now()}.${crypto.randomBytes(24).toString('hex')}`;
  const signature = crypto
    .createHmac('sha256', process.env.GOOGLE_CLIENT_SECRET)
    .update(payload)
    .digest('hex');

  return `${payload}.${signature}`;
}

function isValidOAuthState(state) {
  const match = String(state ?? '').match(/^(\d+)\.([a-f0-9]{48})\.([a-f0-9]{64})$/);
  if (!match) {
    return false;
  }

  const [, timestamp, nonce, receivedSignature] = match;
  const payload = `${timestamp}.${nonce}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.GOOGLE_CLIENT_SECRET)
    .update(payload)
    .digest('hex');
  const ageMs = Date.now() - Number(timestamp);

  return ageMs >= 0
    && ageMs <= 10 * 60 * 1000
    && crypto.timingSafeEqual(
      Buffer.from(receivedSignature, 'hex'),
      Buffer.from(expectedSignature, 'hex'),
    );
}

function bytesToMb(value) {
  return Math.round((Number(value || 0) / 1024 / 1024) * 100) / 100;
}

const russianMonths = [
  ['январ', 1], ['феврал', 2], ['март', 3], ['апрел', 4],
  ['май', 5], ['мая', 5], ['июн', 6], ['июл', 7],
  ['август', 8], ['сентябр', 9], ['октябр', 10],
  ['ноябр', 11], ['декабр', 12],
];

function getMonthNumber(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return russianMonths.find(([name]) => normalized.includes(name))?.[1] ?? 0;
}

function getMonthSortValue(value) {
  const year = Number(String(value ?? '').match(/\b(20\d{2})\b/)?.[1] ?? 0);
  return year * 100 + getMonthNumber(value);
}

function findPlanSheetTitle(month, sheetTitles) {
  const monthNumber = getMonthNumber(month);
  if (!monthNumber) return null;

  return sheetTitles.find((title) => (
    /^план\/факт new\b/i.test(title.trim()) && getMonthNumber(title) === monthNumber
  )) ?? null;
}

function getLatestMonth(months) {
  return [...months].sort((a, b) => getMonthSortValue(b) - getMonthSortValue(a))[0] ?? '';
}

function getMonthChoices(rawRows) {
  const choices = new Map();

  for (const row of getSalesRows(rawRows).rows) {
    const key = row.date?.slice(0, 7);
    if (key && row.month && !choices.has(key)) {
      choices.set(key, { key, label: row.month });
    }
  }

  return [...choices.values()].sort((a, b) => b.key.localeCompare(a.key));
}

function normalizeDashboardDate(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';

  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : null;
  const isValid = date
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);

  if (!isValid) {
    const error = new Error(`Invalid ${fieldName}. Expected YYYY-MM-DD.`);
    error.status = 400;
    throw error;
  }

  return normalized;
}

function getDashboardFilters(query = {}) {
  const month = String(query.month ?? '').trim();
  const dateFrom = normalizeDashboardDate(query.from, 'from');
  const dateTo = normalizeDashboardDate(query.to, 'to');

  if (month) assertValidMonth(month);
  if (dateFrom && dateTo && dateFrom > dateTo) {
    const error = new Error('The start date must not be later than the end date.');
    error.status = 400;
    throw error;
  }

  return {
    month: dateFrom || dateTo ? '' : month,
    dateFrom,
    dateTo,
  };
}

function normalizeFile(file) {
  return {
    ...file,
    sizeBytes: Number(file.size || 0),
    sizeMb: bytesToMb(file.size),
    ownerEmails: file.owners?.map((owner) => owner.emailAddress).filter(Boolean) ?? [],
  };
}

async function listDriveFiles(drive, limit = 200) {
  const files = [];
  let pageToken;

  while (files.length < limit) {
    const { data } = await drive.files.list({
      pageSize: Math.min(100, limit - files.length),
      pageToken,
      fields: `nextPageToken,files(${driveFileFields})`,
      orderBy: 'modifiedTime desc',
    });

    files.push(...(data.files ?? []).map(normalizeFile));
    pageToken = data.nextPageToken;

    if (!pageToken) {
      break;
    }
  }

  return files;
}

function analyzeDriveFiles(files) {
  const byMimeType = new Map();
  const duplicateCandidates = new Map();
  const ownerCounts = new Map();

  for (const file of files) {
    const type = file.mimeType || 'unknown';
    const typeStats = byMimeType.get(type) ?? { mimeType: type, count: 0, sizeBytes: 0, sizeMb: 0 };
    typeStats.count += 1;
    typeStats.sizeBytes += file.sizeBytes;
    typeStats.sizeMb = bytesToMb(typeStats.sizeBytes);
    byMimeType.set(type, typeStats);

    const duplicateKey = `${file.name.trim().toLowerCase()}::${file.sizeBytes}`;
    const group = duplicateCandidates.get(duplicateKey) ?? [];
    group.push(file);
    duplicateCandidates.set(duplicateKey, group);

    for (const email of file.ownerEmails) {
      ownerCounts.set(email, (ownerCounts.get(email) ?? 0) + 1);
    }
  }

  const largeFiles = [...files]
    .filter((file) => file.sizeBytes > 0)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 10);

  const duplicates = [...duplicateCandidates.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => b[0].sizeBytes * b.length - a[0].sizeBytes * a.length)
    .slice(0, 10);

  const externalOwners = [...ownerCounts.entries()]
    .filter(([email]) => email !== 't.aigazinov@gmail.com')
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalFiles: files.length,
    totalKnownSizeMb: bytesToMb(files.reduce((sum, file) => sum + file.sizeBytes, 0)),
    byMimeType: [...byMimeType.values()].sort((a, b) => b.count - a.count),
    largeFiles,
    duplicates,
    externalOwners,
    recommendations: [
      'Проверить largeFiles: один большой видеофайл может занимать больше места, чем сотни документов.',
      'Проверить duplicates: это кандидаты по совпадению имени и размера, перед удалением нужна ручная проверка.',
      'Проверить externalOwners: это файлы, которыми владеют другие аккаунты; они могут пропасть при отзыве доступа владельцем.',
    ],
  };
}

function columnToLetter(columnNumber) {
  let result = '';
  let current = columnNumber;

  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - remainder) / 26);
  }

  return result;
}

function summarizeSheetRows(rows) {
  const headerIndex = rows.findIndex((row) => row.some((cell) => String(cell).trim()));
  const headers = headerIndex >= 0 ? rows[headerIndex] : [];
  const dataRows = headerIndex >= 0 ? rows.slice(headerIndex + 1) : [];

  return {
    headerRow: headerIndex >= 0 ? headerIndex + 1 : null,
    headers,
    nonEmptyRows: rows.filter((row) => row.some((cell) => String(cell).trim())).length,
    sampleRows: dataRows
      .filter((row) => row.some((cell) => String(cell).trim()))
      .slice(0, 10),
  };
}

function parseMoney(value) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }

  const normalized = String(value)
    .replace(/\s/g, '')
    .replace(/\u00a0/g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '');

  return Number(normalized) || 0;
}

function parseInteger(value) {
  return Number(String(value ?? '').replace(/[^\d.-]/g, '')) || 0;
}

function parsePercent(value) {
  const normalized = String(value ?? '').trim().replace('%', '').replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function parseSheetDate(value) {
  const match = String(value ?? '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) {
    return null;
  }

  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(date) {
  const match = String(date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return String(date ?? '');
  }

  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}

function groupMetric(rows, keyGetter, valueGetter = (row) => row.amount) {
  const grouped = new Map();

  for (const row of rows) {
    const key = keyGetter(row) || 'Не указано';
    const current = grouped.get(key) ?? { name: key, revenue: 0, count: 0, quantity: 0 };
    current.revenue += valueGetter(row);
    current.count += 1;
    current.quantity += row.quantity;
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((item) => ({
      ...item,
      revenue: Math.round(item.revenue * 100) / 100,
      averageCheck: item.count ? Math.round((item.revenue / item.count) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

function rowsToObjects(rows) {
  const headerIndex = rows.findIndex((row) => row.includes('Дата') && row.includes('Сумма'));
  if (headerIndex < 0) {
    return [];
  }

  const headers = rows[headerIndex].map((header) => String(header).trim());

  return rows.slice(headerIndex + 1)
    .filter((row) => row.some((cell) => String(cell ?? '').trim()))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
}

function getSalesRows(rawRows) {
  const rawObjects = rowsToObjects(rawRows);
  const rows = rawObjects
    .map((row) => {
      const amount = parseMoney(row['Сумма']);
      const price = parseMoney(row['Цена']);
      const quantity = parseInteger(row['Кол-во']) || 1;
      const operationType = String(row['Тип операции'] || '').trim();

      return {
        date: parseSheetDate(row['Дата']),
        month: String(row['Месяц'] || '').trim(),
        manager: String(row['Менеджер'] || '').trim(),
        channel: String(row['Канал продажи'] || '').trim(),
        clientName: String(row['Имя клиента'] || '').trim(),
        source: String(row['Источник'] || '').trim(),
        barcode: String(row['Шрихкод'] || row['Штрихкод'] || '').trim(),
        product: normalizeProductName(row['Товар']),
        category: String(row['Категория'] || '').trim(),
        color: String(row['Цвет'] || '').trim(),
        size: String(row['Размер'] || '').trim(),
        operationType,
        quantity,
        price,
        discountPercent: parsePercent(row['Скидка']),
        amount,
        paymentMethod: String(row['Способ оплаты'] || '').trim(),
        returnReason: String(row['Причина возврата'] || '').trim(),
        isReturn: operationType.toLowerCase().includes('возврат') || amount < 0,
      };
    })
    .filter((row) => row.month && row.operationType);

  return { rawObjects, rows };
}

function analyzeSalesRows(rawRows, options = {}) {
  const { rawObjects, rows: allRows } = getSalesRows(rawRows);
  const rows = allRows.filter((row) => {
    if (options.date && row.date !== options.date) {
      return false;
    }

    if (options.month && row.month !== options.month) {
      return false;
    }

    if (options.monthKey && row.date?.slice(0, 7) !== options.monthKey) {
      return false;
    }

    if (options.dateFrom && (!row.date || row.date < options.dateFrom)) {
      return false;
    }

    if (options.dateTo && (!row.date || row.date > options.dateTo)) {
      return false;
    }

    return true;
  });
  const sales = rows.filter(
    (row) => row.operationType.trim().toLowerCase() === 'продажа' && row.amount > 0,
  );
  const returns = rows.filter((row) => row.isReturn);
  const revenue = sales.reduce((sum, row) => sum + row.amount, 0);
  const quantity = sales.reduce((sum, row) => sum + row.quantity, 0);
  const discountRows = sales.filter((row) => row.discountPercent > 0);
  const productsByQuantity = groupProductsByQuantity(sales);

  return {
    sheetRows: rawRows.length,
    dataRowsAfterHeader: rawObjects.length,
    rows: rows.length,
    skippedRows: Math.max(rawObjects.length - allRows.length, 0),
    salesCount: sales.length,
    returnCount: returns.length,
    revenue: Math.round(revenue * 100) / 100,
    quantity,
    averageCheck: sales.length ? Math.round((revenue / sales.length) * 100) / 100 : 0,
    averageItemRevenue: quantity ? Math.round((revenue / quantity) * 100) / 100 : 0,
    discountedSalesCount: discountRows.length,
    averageDiscountPercent: discountRows.length
      ? Math.round((discountRows.reduce((sum, row) => sum + row.discountPercent, 0) / discountRows.length) * 100) / 100
      : 0,
    byManager: groupMetric(sales, (row) => row.manager),
    byChannel: groupMetric(sales, (row) => row.channel),
    bySource: groupMetric(sales, (row) => row.source).slice(0, 15),
    byPaymentMethod: groupMetric(sales, (row) => row.paymentMethod),
    topProducts: productsByQuantity.slice(0, 15),
    topProductsByQuantity: productsByQuantity,
    returns: groupMetric(returns, (row) => row.returnReason || row.manager, (row) => Math.abs(row.amount)),
    months: [...new Set(allRows.map((row) => row.month).filter(Boolean))],
    dailyRevenue: groupMetric(sales, (row) => row.date)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({ date: row.name, revenue: row.revenue, count: row.count })),
    monthlyRevenue: groupMetric(
      allRows.filter(
        (row) => row.operationType.trim().toLowerCase() === 'продажа' && row.amount > 0,
      ),
      (row) => row.month,
    ),
  };
}

function formatCurrency(value) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
  }).format(value);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderMetricTable(title, rows, columns = ['revenue', 'count', 'averageCheck']) {
  const columnLabels = {
    revenue: 'Выручка',
    count: 'Чеков',
    quantity: 'Кол-во',
    averageCheck: 'Средний чек',
  };

  return `
    <section class="panel">
      <h2>${escapeHtml(title)}</h2>
      <table>
        <thead>
          <tr>
            <th>Название</th>
            ${columns.map((column) => `<th>${columnLabels[column]}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.name)}</td>
              ${columns.map((column) => `<td>${column === 'count' || column === 'quantity' ? row[column] : formatCurrency(row[column])}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function renderDashboard(analysis, filters = {}) {
  const monthOptions = (analysis.monthChoices ?? []).map(({ key, label }) => `
    <option value="${escapeHtml(key)}" ${key === filters.month ? 'selected' : ''}>${escapeHtml(label)}</option>
  `).join('');
  const periodLabel = filters.dateFrom || filters.dateTo
    ? `${filters.dateFrom ? formatDisplayDate(filters.dateFrom) : 'начала'} — ${filters.dateTo ? formatDisplayDate(filters.dateTo) : 'сегодня'}`
    : (analysis.monthChoices?.find(({ key }) => key === filters.month)?.label || 'всё время');

  return `
    <!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>ProdFin — Продажи</title>
        <style>
          :root {
            --navy: #0b1739;
            --navy-2: #132654;
            --blue: #2864dc;
            --cyan: #29b6d8;
            --ink: #17213b;
            --muted: #71809f;
            --bg: #f4f7fc;
            --panel: #ffffff;
            --line: #e4eaf4;
          }

          * { box-sizing: border-box; }

          body {
            margin: 0;
            color: var(--ink);
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: var(--bg);
          }

          .shell {
            min-height: 100vh;
            display: grid;
            grid-template-columns: 228px minmax(0, 1fr);
          }

          aside {
            position: sticky;
            top: 0;
            height: 100vh;
            padding: 26px 18px;
            color: #cbd7f3;
            background: linear-gradient(180deg, var(--navy), #071028);
          }

          .brand {
            display: flex;
            align-items: center;
            gap: 11px;
            padding: 0 10px 30px;
            color: white;
            font-size: 19px;
            font-weight: 750;
            letter-spacing: -.03em;
          }

          .brand-mark {
            display: grid;
            width: 34px;
            height: 34px;
            place-items: center;
            border-radius: 10px;
            background: linear-gradient(135deg, var(--blue), var(--cyan));
            box-shadow: 0 8px 24px rgba(41, 182, 216, .25);
          }

          nav a {
            display: flex;
            align-items: center;
            gap: 12px;
            margin: 5px 0;
            padding: 11px 12px;
            border-radius: 10px;
            color: #91a2c8;
            font-size: 14px;
            font-weight: 600;
            text-decoration: none;
          }

          nav a.active {
            color: white;
            background: var(--navy-2);
            box-shadow: inset 3px 0 var(--cyan);
          }

          .nav-icon { width: 20px; color: #6f83b3; text-align: center; }

          .sidebar-note {
            position: absolute;
            right: 18px;
            bottom: 24px;
            left: 18px;
            padding: 14px;
            border: 1px solid rgba(255,255,255,.08);
            border-radius: 12px;
            color: #8da0c7;
            background: rgba(255,255,255,.04);
            font-size: 11px;
            line-height: 1.5;
          }

          main { min-width: 0; padding: 30px 34px 48px; }

          .top {
            display: flex;
            justify-content: space-between;
            gap: 18px;
            align-items: center;
            margin-bottom: 26px;
          }

          h1 {
            margin: 0 0 7px;
            font-size: 28px;
            line-height: 1.1;
            letter-spacing: -.035em;
          }

          .subtitle {
            margin: 0;
            color: var(--muted);
            font-size: 13px;
          }

          .filters {
            display: flex;
            align-items: end;
            gap: 10px;
            margin-bottom: 18px;
            padding: 14px 16px;
            border: 1px solid var(--line);
            border-radius: 13px;
            background: var(--panel);
            box-shadow: 0 5px 18px rgba(27,50,94,.04);
          }

          .filter-field { display: grid; gap: 6px; }
          .filter-field label { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
          .filter-field select, .filter-field input {
            height: 38px;
            min-width: 145px;
            padding: 0 11px;
            border: 1px solid var(--line);
            border-radius: 9px;
            color: var(--ink);
            background: white;
            font: inherit;
            font-size: 13px;
          }
          .filter-actions { display: flex; gap: 8px; }
          .filter-button {
            display: inline-grid;
            height: 38px;
            padding: 0 16px;
            place-items: center;
            border: 0;
            border-radius: 9px;
            color: white;
            background: var(--blue);
            font: inherit;
            font-size: 13px;
            font-weight: 700;
            text-decoration: none;
            cursor: pointer;
          }
          .filter-button.secondary { color: var(--ink); background: #edf2fa; }
          .period-note { margin-left: auto; color: var(--muted); font-size: 12px; }

          .stamp {
            min-width: 190px;
            padding: 13px 16px;
            border: 1px solid var(--line);
            border-radius: 10px;
            background: var(--panel);
            box-shadow: 0 3px 12px rgba(31,55,104,.05);
          }

          .stamp strong { display: block; margin-top: 5px; font-size: 24px; line-height: 1; }
          .stamp p { margin: 7px 0 0; color: var(--muted); font-size: 11px; }

          .cards {
            display: grid;
            grid-template-columns: repeat(6, minmax(0, 1fr));
            gap: 12px;
            margin-bottom: 14px;
          }

          .card, .panel {
            border: 1px solid var(--line);
            border-radius: 13px;
            background: var(--panel);
            box-shadow: 0 8px 28px rgba(27,50,94,.055);
          }

          .card {
            position: relative;
            min-width: 0;
            min-height: 122px;
            padding: 17px;
            overflow: hidden;
          }

          .card::before { position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg,var(--blue),var(--cyan)); content: ""; }

          .label {
            color: var(--muted);
            font-size: 11px;
            font-weight: 700;
            letter-spacing: .07em;
            text-transform: uppercase;
          }

          .value {
            margin-top: 20px;
            overflow: hidden;
            font-size: clamp(23px, 2.35vw, 34px);
            font-weight: 760;
            line-height: 1;
            letter-spacing: -.045em;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 14px;
          }

          .panel { min-width: 0; overflow: hidden; }

          .panel h2 {
            margin: 0;
            padding: 17px 19px;
            font-size: 15px;
            font-weight: 750;
            letter-spacing: -.015em;
            border-bottom: 1px solid var(--line);
          }

          table {
            width: 100%;
            border-collapse: collapse;
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 12px;
          }

          th, td {
            padding: 11px 14px;
            text-align: left;
            border-bottom: 1px solid var(--line);
            vertical-align: top;
          }

          th {
            color: var(--muted);
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.08em;
          }

          td:not(:first-child), th:not(:first-child) {
            text-align: right;
            white-space: nowrap;
          }

          tr:last-child td {
            border-bottom: 0;
          }

          @media (max-width: 1000px) {
            .shell { grid-template-columns: 78px minmax(0, 1fr); }
            aside { padding-inline: 12px; }
            .brand-name, nav span:not(.nav-icon), .sidebar-note { display: none; }
            nav a { justify-content: center; }
            .cards { grid-template-columns: repeat(2, 1fr); }
            .grid { grid-template-columns: 1fr; }
          }

          @media (max-width: 650px) {
            .shell { display: block; }
            aside { position: static; display: flex; align-items: center; width: 100%; height: auto; padding: 12px 14px; }
            .brand { padding: 0; }
            nav { display: flex; margin-left: auto; }
            nav a { margin: 0 0 0 6px; padding: 10px 12px; }
            .sidebar-note { display: none; }
            main { padding: 22px 14px 36px; }
            .top { display: block; }
            .filters { align-items: stretch; flex-direction: column; }
            .filter-field select, .filter-field input { width: 100%; }
            .period-note { margin: 0; }
            .filter-actions { display: grid; grid-template-columns: 1fr 1fr; }
            .stamp { width: 100%; margin-top: 16px; }
            .cards { grid-template-columns: 1fr; }
            .panel { overflow-x: auto; }
            table { font-size: 11px; }
            th, td { padding: 10px; }
          }
        </style>
      </head>
      <body>
        <div class="shell">
          <aside>
            <div class="brand"><span class="brand-mark">P</span><span class="brand-name">ProdFin</span></div>
            <nav aria-label="Основная навигация">
              <a href="/business"><span class="nav-icon">◫</span><span>Обзор</span></a>
              <a class="active" href="/dashboard"><span class="nav-icon">↗</span><span>Продажи</span></a>
            </nav>
            <div class="sidebar-note">Данные синхронизируются с Google Sheets при каждом открытии страницы.</div>
          </aside>
          <main>
          <section class="top">
            <div>
              <h1>Продажи</h1>
              <p class="subtitle">Детальная аналитика по листу «Продажи» из Google Sheets.</p>
            </div>
            <div class="stamp">
              <span class="label">Валидных строк</span>
              <strong>${analysis.rows}</strong>
              <p>${analysis.skippedRows} строк пропущено как пустые/шаблонные</p>
            </div>
          </section>

          <form class="filters" action="/dashboard" method="get" data-dashboard-filters>
            <div class="filter-field">
              <label for="dashboard-month">Месяц</label>
              <select id="dashboard-month" name="month">
                <option value="">Всё время</option>
                ${monthOptions}
              </select>
            </div>
            <div class="filter-field">
              <label for="dashboard-from">От</label>
              <input id="dashboard-from" name="from" type="date" value="${escapeHtml(filters.dateFrom)}">
            </div>
            <div class="filter-field">
              <label for="dashboard-to">До</label>
              <input id="dashboard-to" name="to" type="date" value="${escapeHtml(filters.dateTo)}">
            </div>
            <div class="filter-actions">
              <button class="filter-button" type="submit">Показать</button>
              <a class="filter-button secondary" href="/dashboard">Сбросить</a>
            </div>
            <div class="period-note">Сейчас: ${escapeHtml(periodLabel)}</div>
          </form>

          <section class="cards">
            <article class="card">
              <div class="label">Выручка</div>
              <div class="value">${formatCurrency(analysis.revenue)}</div>
            </article>
            <article class="card">
              <div class="label">Продажи</div>
              <div class="value">${analysis.salesCount}</div>
            </article>
            <article class="card">
              <div class="label">Средний чек</div>
              <div class="value">${formatCurrency(analysis.averageCheck)}</div>
            </article>
            <article class="card">
              <div class="label">Возвраты</div>
              <div class="value">${analysis.returnCount}</div>
            </article>
            <article class="card">
              <div class="label">Строк после заголовка</div>
              <div class="value">${analysis.dataRowsAfterHeader}</div>
            </article>
            <article class="card">
              <div class="label">Пропущено</div>
              <div class="value">${analysis.skippedRows}</div>
            </article>
          </section>

          <section class="grid">
            ${renderMetricTable('Менеджеры', analysis.byManager)}
            ${renderMetricTable('Каналы продаж', analysis.byChannel)}
            ${renderMetricTable('Источники', analysis.bySource.slice(0, 10))}
            ${renderMetricTable('Способы оплаты', analysis.byPaymentMethod)}
            ${renderMetricTable('Топ товаров по количеству', analysis.topProducts.slice(0, 10), ['revenue', 'quantity', 'averageCheck'])}
            ${renderMetricTable('Возвраты', analysis.returns, ['revenue', 'count'])}
          </section>
          </main>
        </div>
        <script>
          (() => {
            const form = document.querySelector('[data-dashboard-filters]');
            const month = form.querySelector('[name="month"]');
            const from = form.querySelector('[name="from"]');
            const to = form.querySelector('[name="to"]');
            month.addEventListener('change', () => {
              if (month.value) {
                from.value = '';
                to.value = '';
              }
            });
            [from, to].forEach((input) => input.addEventListener('change', () => {
              if (input.value) month.value = '';
            }));
            setTimeout(() => location.reload(), ${SHEETS_SYNC_INTERVAL_MS});
          })();
        </script>
      </body>
    </html>
  `;
}

function renderBarRows(rows, valueKey = 'revenue') {
  const max = Math.max(...rows.map((row) => row[valueKey]), 1);

  return rows.map((row) => {
    const width = Math.max((row[valueKey] / max) * 100, 2);
    return `
      <div class="bar-row">
        <span>${escapeHtml(row.name ?? row.date)}</span>
        <div><i style="width: ${width}%"></i></div>
        <b>${formatCurrency(row[valueKey])}</b>
      </div>
    `;
  }).join('');
}

function renderProductRows(rows, pageSize = 10) {
  const maxQuantity = Math.max(...rows.map((row) => row.quantity), 1);
  const totalPages = Math.max(Math.ceil(rows.length / pageSize), 1);

  const productRows = rows.map((row, index) => {
    const width = Math.max((row.quantity / maxQuantity) * 100, 2);
    return `
      <div class="bar-row product-row" data-product-row data-index="${index}"${index >= pageSize ? ' hidden' : ''}>
        <span>${escapeHtml(row.name)}</span>
        <div><i style="width: ${width}%"></i></div>
        <b>${row.quantity} шт. · ${formatCurrency(row.revenue)}</b>
      </div>
    `;
  }).join('');

  return `
    <div id="product-ranking">${productRows}</div>
    <div class="pagination" id="product-pagination">
      <button type="button" data-page-prev disabled>Назад</button>
      <span data-page-status>Страница 1 из ${totalPages}</span>
      <button type="button" data-page-next${totalPages === 1 ? ' disabled' : ''}>Вперёд</button>
    </div>
    <script>
      (() => {
        const root = document.getElementById('product-ranking');
        const pagination = document.getElementById('product-pagination');
        const rows = [...root.querySelectorAll('[data-product-row]')];
        const pageSize = ${pageSize};
        const totalPages = ${totalPages};
        let page = 1;

        const renderPage = () => {
          rows.forEach((row, index) => {
            row.hidden = index < (page - 1) * pageSize || index >= page * pageSize;
          });
          pagination.querySelector('[data-page-status]').textContent = 'Страница ' + page + ' из ' + totalPages;
          pagination.querySelector('[data-page-prev]').disabled = page === 1;
          pagination.querySelector('[data-page-next]').disabled = page === totalPages;
        };

        pagination.querySelector('[data-page-prev]').addEventListener('click', () => {
          if (page > 1) page -= 1;
          renderPage();
        });
        pagination.querySelector('[data-page-next]').addEventListener('click', () => {
          if (page < totalPages) page += 1;
          renderPage();
        });
      })();
    </script>
  `;
}

function renderBusinessDashboard({ analysis, plan, selectedMonth, selectedMonthKey, umag }) {
  const planValue = plan?.monthlyPlan ?? 0;
  const revenueValue = umag.revenue;
  const planCompletion = planValue
    ? Math.round((revenueValue / planValue) * 10000) / 100
    : null;
  const remaining = planValue ? Math.max(planValue - revenueValue, 0) : null;
  const monthOptions = analysis.monthChoices.map(({ key, label }) => `
    <option value="${escapeHtml(key)}" ${key === selectedMonthKey ? 'selected' : ''}>${escapeHtml(label)}</option>
  `).join('');

  return `
    <!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Business Analytics</title>
        <style>
          :root {
            --navy: #0b1739;
            --navy-2: #132654;
            --blue: #2864dc;
            --cyan: #29b6d8;
            --green: #17a673;
            --ink: #17213b;
            --muted: #71809f;
            --bg: #f4f7fc;
            --panel: #ffffff;
            --line: #e4eaf4;
          }

          * { box-sizing: border-box; }

          body {
            margin: 0;
            color: var(--ink);
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: var(--bg);
          }

          .shell {
            min-height: 100vh;
            display: grid;
            grid-template-columns: 228px minmax(0, 1fr);
          }

          aside {
            position: sticky;
            top: 0;
            height: 100vh;
            padding: 26px 18px;
            color: #cbd7f3;
            background: linear-gradient(180deg, var(--navy), #071028);
          }

          .brand {
            display: flex;
            align-items: center;
            gap: 11px;
            padding: 0 10px 30px;
            color: white;
            font-size: 19px;
            font-weight: 750;
            letter-spacing: -0.03em;
          }

          .brand-mark {
            display: grid;
            width: 34px;
            height: 34px;
            place-items: center;
            border-radius: 10px;
            background: linear-gradient(135deg, var(--blue), var(--cyan));
            box-shadow: 0 8px 24px rgba(41, 182, 216, .25);
          }

          nav a {
            display: flex;
            align-items: center;
            gap: 12px;
            margin: 5px 0;
            padding: 11px 12px;
            border-radius: 10px;
            color: #91a2c8;
            font-size: 14px;
            font-weight: 600;
            text-decoration: none;
          }

          nav a.active {
            color: white;
            background: var(--navy-2);
            box-shadow: inset 3px 0 var(--cyan);
          }

          .nav-icon {
            width: 20px;
            color: #6f83b3;
            text-align: center;
          }

          .sidebar-note {
            position: absolute;
            right: 18px;
            bottom: 24px;
            left: 18px;
            padding: 14px;
            border: 1px solid rgba(255,255,255,.08);
            border-radius: 12px;
            color: #8da0c7;
            background: rgba(255,255,255,.04);
            font-size: 11px;
            line-height: 1.5;
          }

          main {
            min-width: 0;
            padding: 30px 34px 48px;
          }

          .top {
            display: flex;
            justify-content: space-between;
            gap: 18px;
            align-items: center;
            margin-bottom: 26px;
          }

          h1 {
            margin: 0;
            font-size: 28px;
            line-height: 1.1;
            letter-spacing: -0.035em;
          }

          .muted {
            color: var(--muted);
            font-size: 13px;
          }

          form {
            display: flex;
            gap: 10px;
            align-items: center;
          }

          select, button {
            border: 1px solid var(--line);
            border-radius: 9px;
            padding: 10px 13px;
            background: white;
            color: var(--ink);
            font: 13px inherit;
            box-shadow: 0 3px 12px rgba(31, 55, 104, .05);
          }

          button {
            color: white;
            border-color: var(--blue);
            background: var(--blue);
            font-weight: 650;
            cursor: pointer;
          }

          .cards {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 12px;
            margin-bottom: 14px;
          }

          main.is-loading { opacity: .62; pointer-events: none; }
          .business-error { margin: 8px 0 0; color: #b42318; font-size: 12px; }

          .card, .panel {
            border: 1px solid var(--line);
            border-radius: 13px;
            background: var(--panel);
            box-shadow: 0 8px 28px rgba(27, 50, 94, .055);
          }

          .card {
            position: relative;
            min-width: 0;
            min-height: 122px;
            padding: 17px;
            overflow: hidden;
          }

          .card::before {
            position: absolute;
            top: 0;
            right: 0;
            left: 0;
            height: 3px;
            background: linear-gradient(90deg, var(--blue), var(--cyan));
            content: "";
          }

          .label {
            color: var(--muted);
            font-size: 11px;
            font-weight: 700;
            letter-spacing: .07em;
            text-transform: uppercase;
          }

          .value {
            margin-top: 20px;
            overflow: hidden;
            font-size: clamp(23px, 2.35vw, 34px);
            font-weight: 760;
            letter-spacing: -.045em;
            line-height: 1;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .layout {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 14px;
          }

          .panel {
            min-width: 0;
            padding: 19px;
          }

          .wide {
            grid-column: 1 / -1;
          }

          h2 {
            margin: 0 0 17px;
            font-size: 15px;
            font-weight: 750;
            letter-spacing: -.015em;
          }

          .progress {
            height: 11px;
            overflow: hidden;
            border-radius: 999px;
            background: #eaf0f9;
          }

          .progress i {
            display: block;
            height: 100%;
            width: ${Math.min(planCompletion ?? 0, 100)}%;
            border-radius: inherit;
            background: linear-gradient(90deg, var(--blue), var(--cyan));
            box-shadow: 0 0 14px rgba(41, 182, 216, .35);
          }

          .plan-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
            margin-bottom: 18px;
          }

          .plan-stat {
            padding: 14px;
            border: 1px solid var(--line);
            border-radius: 10px;
            background: #f8faff;
          }

          .plan-stat span {
            display: block;
            margin-bottom: 7px;
            color: var(--muted);
            font-size: 10px;
            font-weight: 700;
            letter-spacing: .06em;
            text-transform: uppercase;
          }

          .plan-stat strong {
            font-size: 20px;
            letter-spacing: -.035em;
          }

          .progress-caption {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            margin-top: 10px;
            color: var(--muted);
            font-size: 12px;
          }

          .bar-row {
            display: grid;
            grid-template-columns: minmax(130px, 1fr) 2fr minmax(90px, auto);
            gap: 14px;
            align-items: center;
            padding: 9px 0;
            border-top: 1px solid var(--line);
            font-size: 12px;
          }

          .product-row[hidden] { display: none; }

          .bar-row div {
            height: 7px;
            overflow: hidden;
            border-radius: 999px;
            background: #edf1f8;
          }

          .bar-row i {
            display: block;
            height: 100%;
            border-radius: inherit;
            background: linear-gradient(90deg, var(--blue), #5489eb);
          }

          .bar-row b {
            text-align: right;
            font-variant-numeric: tabular-nums;
          }

          .pagination {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            align-items: center;
            margin-top: 16px;
          }

          .pagination span {
            color: var(--muted);
            font-size: 12px;
          }

          .pagination button:disabled {
            cursor: default;
            opacity: .45;
          }

          @media (max-width: 1000px) {
            .shell { grid-template-columns: 78px minmax(0, 1fr); }
            aside { padding-inline: 12px; }
            .brand { padding-inline: 10px; }
            .brand-name, nav span:not(.nav-icon), .sidebar-note { display: none; }
            nav a { justify-content: center; }
            .cards { grid-template-columns: repeat(2, 1fr); }
            .layout { grid-template-columns: 1fr; }
            .top { display: block; }
            form { margin-top: 18px; width: fit-content; }
          }

          @media (max-width: 650px) {
            .shell { display: block; }
            aside {
              position: static;
              display: flex;
              align-items: center;
              width: 100%;
              height: auto;
              padding: 12px 14px;
            }
            .brand { padding: 0; }
            nav { display: flex; margin-left: auto; }
            nav a { margin: 0 0 0 6px; padding: 10px 12px; }
            .sidebar-note { display: none; }
            main { padding: 22px 14px 36px; }
            .cards { grid-template-columns: 1fr; }
            .plan-grid { grid-template-columns: 1fr; }
            .bar-row { grid-template-columns: 1fr; }
            .bar-row b { text-align: left; }
            form { width: 100%; }
            select { min-width: 0; flex: 1; }
          }
        </style>
      </head>
      <body>
        <div class="shell">
          <aside>
            <div class="brand">
              <span class="brand-mark">P</span>
              <span class="brand-name">ProdFin</span>
            </div>
            <nav aria-label="Основная навигация">
              <a class="active" href="/business"><span class="nav-icon">◫</span><span>Обзор</span></a>
              <a href="/dashboard"><span class="nav-icon">↗</span><span>Продажи</span></a>
            </nav>
            <div class="sidebar-note">Данные синхронизируются с Google Sheets при каждом открытии страницы.</div>
          </aside>
          <main>
          <section class="top">
            <div>
              <h1>Бизнес-аналитика</h1>
              <p class="muted">Период: ${escapeHtml(selectedMonth || selectedMonthKey)} · выручка, себестоимость и маржа из UMAG · ${plan.sheetTitle ? `план из листа “${escapeHtml(plan.sheetTitle)}”` : 'отдельного планового листа нет'}.</p>
            </div>
            <div class="filter-wrap">
              <form action="/business" method="get" data-business-filter>
                <select name="month">
                  ${monthOptions}
                </select>
                <button type="submit">Показать</button>
              </form>
              <p class="business-error" data-business-error role="alert" hidden></p>
            </div>
          </section>

          <section class="cards">
            <article class="card"><div class="label">Выручка</div><div class="value">${formatCurrency(revenueValue)}</div></article>
            <article class="card"><div class="label">Себестоимость</div><div class="value">${formatCurrency(umag.cost)}</div></article>
            <article class="card"><div class="label">Маржинальность</div><div class="value">${formatPercent(umag.grossMargin)}</div></article>
            <article class="card"><div class="label">План</div><div class="value">${planValue ? formatCurrency(planValue) : 'нет'}</div></article>
            <article class="card"><div class="label">Выполнение</div><div class="value">${planCompletion === null ? 'нет' : `${planCompletion}%`}</div></article>
            <article class="card"><div class="label">Продажи</div><div class="value">${analysis.salesCount}</div></article>
            <article class="card"><div class="label">Средний чек</div><div class="value">${formatCurrency(analysis.averageCheck)}</div></article>
            <article class="card"><div class="label">Возвраты</div><div class="value">${analysis.returnCount}</div></article>
          </section>

          <section class="layout">
            <article class="panel wide">
              <h2>План / факт</h2>
              <div class="plan-grid">
                <div class="plan-stat"><span>План периода</span><strong>${planValue ? formatCurrency(planValue) : 'Не задан'}</strong></div>
                <div class="plan-stat"><span>Фактическая выручка</span><strong>${formatCurrency(revenueValue)}</strong></div>
                <div class="plan-stat"><span>Осталось до плана</span><strong>${remaining === null ? 'Нет данных' : formatCurrency(remaining)}</strong></div>
              </div>
              <div class="progress"><i></i></div>
              <div class="progress-caption">
                <span>Выполнено ${planCompletion === null ? '—' : `${planCompletion}%`}</span>
                <span>По листу «Продажи»: ${formatCurrency(analysis.revenue)}</span>
              </div>
            </article>

            <article class="panel wide">
              <h2>Продажи по количеству</h2>
              ${renderProductRows(analysis.topProductsByQuantity)}
            </article>

            <article class="panel">
              <h2>Каналы продаж</h2>
              ${renderBarRows(analysis.byChannel, 'revenue')}
            </article>

            <article class="panel">
              <h2>Аналитика возвратов</h2>
              ${analysis.returns.length
                ? renderBarRows(analysis.returns.slice(0, 10), 'revenue')
                : '<p class="muted">За выбранный период возвратов нет.</p>'}
            </article>

            <article class="panel">
              <h2>Менеджеры</h2>
              ${renderBarRows(analysis.byManager, 'revenue')}
            </article>

            <article class="panel">
              <h2>Источники продаж</h2>
              ${renderBarRows(analysis.bySource.slice(0, 12), 'revenue')}
            </article>
          </section>
          </main>
        </div>
        <script>
          (() => {
            const updateBusiness = async (form) => {
              const main = document.querySelector('main');
              const errorNode = main.querySelector('[data-business-error]');
              const query = new URLSearchParams(new FormData(form));
              const url = '/business?' + query.toString();
              main.classList.add('is-loading');
              main.setAttribute('aria-busy', 'true');
              errorNode.hidden = true;

              try {
                const response = await fetch(url, { headers: { Accept: 'text/html' } });
                if (!response.ok) {
                  const data = await response.json().catch(() => ({}));
                  throw new Error(data.error || 'Не удалось обновить данные.');
                }

                const html = await response.text();
                const nextDocument = new DOMParser().parseFromString(html, 'text/html');
                const nextMain = nextDocument.querySelector('main');
                if (!nextMain) throw new Error('Сервер вернул некорректную страницу.');
                main.replaceWith(nextMain);
                history.pushState({}, '', url);
              } catch (error) {
                main.classList.remove('is-loading');
                main.removeAttribute('aria-busy');
                errorNode.textContent = error.message;
                errorNode.hidden = false;
              }
            };

            document.addEventListener('submit', (event) => {
              const form = event.target.closest('[data-business-filter]');
              if (!form) return;
              event.preventDefault();
              updateBusiness(form);
            });

            document.addEventListener('change', (event) => {
              const form = event.target.closest('[data-business-filter]');
              if (form && event.target.name === 'month') updateBusiness(form);
            });
          })();
        </script>
      </body>
    </html>
  `;
}

function formatPercent(value) {
  return `${new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

function buildDailyReport({ analysis, plan, dayPlan, reportDate }) {
  const topManager = analysis.byManager[0];
  const topChannel = analysis.byChannel[0];
  const topSource = analysis.bySource[0];
  const planValue = dayPlan?.dailyPlan ?? 0;
  const planCompletion = planValue ? (analysis.revenue / planValue) * 100 : 0;
  const remaining = planValue ? Math.max(planValue - analysis.revenue, 0) : 0;
  const displayDate = formatDisplayDate(reportDate);

  return [
    `Daily report: ${displayDate}`,
    '',
    `Выручка: ${formatCurrency(analysis.revenue)}`,
    `План дня: ${planValue ? formatCurrency(planValue) : 'не задан'}`,
    `Выполнение: ${formatPercent(planCompletion)}`,
    `Остаток до плана дня: ${formatCurrency(remaining)}`,
    '',
    `Продажи: ${analysis.salesCount}`,
    `Средний чек: ${formatCurrency(analysis.averageCheck)}`,
    `Возвраты: ${analysis.returnCount}`,
    '',
    topManager ? `Топ менеджер: ${topManager.name} - ${formatCurrency(topManager.revenue)}` : 'Топ менеджер: нет данных',
    topChannel ? `Топ канал: ${topChannel.name} - ${formatCurrency(topChannel.revenue)}` : 'Топ канал: нет данных',
    topSource ? `Топ источник: ${topSource.name} - ${formatCurrency(topSource.revenue)}` : 'Топ источник: нет данных',
    '',
    `Плановый лист: ${plan.reportDate || 'дата не указана'}, день ${dayPlan?.sourceDate || displayDate}, факт ${formatCurrency(dayPlan?.fact ?? 0)}`,
  ].join('\n');
}

async function sendTelegramMessage(text, chatIdOverride) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = chatIdOverride || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram API error: ${response.status}`);
  }

  return data;
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getRelativeDate(keyword) {
  const now = new Date();

  if (keyword === 'yesterday') {
    now.setDate(now.getDate() - 1);
  }

  return toIsoDate(now);
}

async function buildTelegramCommandResponse(text) {
  const [command, ...args] = String(text || '').trim().split(/\s+/);
  const normalizedCommand = command?.split('@')[0].toLowerCase();

  if (!normalizedCommand || normalizedCommand === '/help' || normalizedCommand === '/start') {
    return [
      'Команды Drive Optimizer:',
      '',
      '/today - отчет за сегодня',
      '/yesterday - отчет за вчера',
      '/date YYYY-MM-DD - отчет за дату',
      '/month - бизнес-аналитика за месяц из планового листа',
      '/help - список команд',
    ].join('\n');
  }

  if (normalizedCommand === '/today') {
    const report = await getDailyReport({ date: getRelativeDate('today') });
    return report.text;
  }

  if (normalizedCommand === '/yesterday') {
    const report = await getDailyReport({ date: getRelativeDate('yesterday') });
    return report.text;
  }

  if (normalizedCommand === '/date') {
    const date = args[0];

    if (!date || !date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return 'Формат: /date YYYY-MM-DD';
    }

    const report = await getDailyReport({ date });
    return report.text;
  }

  if (normalizedCommand === '/month') {
    const business = await getBusinessAnalysis();
    const { analysis, plan, selectedMonth } = business;
    const revenue = plan.factFromPlanSheet || analysis.revenue;
    const completion = plan.completionFromPlanSheet
      || (plan.monthlyPlan ? (revenue / plan.monthlyPlan) * 100 : 0);

    return [
      `Monthly report: ${selectedMonth || 'текущий период'}`,
      '',
      `Выручка: ${formatCurrency(revenue)}`,
      `План: ${formatCurrency(plan.monthlyPlan)}`,
      `Выполнение: ${formatPercent(completion)}`,
      `Продажи: ${analysis.salesCount}`,
      `Средний чек: ${formatCurrency(analysis.averageCheck)}`,
      analysis.byManager[0] ? `Топ менеджер: ${analysis.byManager[0].name} - ${formatCurrency(analysis.byManager[0].revenue)}` : 'Топ менеджер: нет данных',
    ].join('\n');
  }

  return 'Неизвестная команда. Напиши /help';
}

async function getDailyReport(options = {}) {
  const initialBusinessAnalysis = await getBusinessAnalysis({ date: options.date || '' });
  const reportDate = options.date || parseSheetDate(initialBusinessAnalysis.plan.reportDate);
  const businessAnalysis = options.date
    ? initialBusinessAnalysis
    : await getBusinessAnalysis({ date: reportDate });
  const finalReportDate = reportDate || parseSheetDate(businessAnalysis.plan.reportDate);
  const dayPlan = businessAnalysis.plan.dailyPlans.find((item) => item.date === finalReportDate);

  return {
    ...businessAnalysis,
    dayPlan,
    reportDate: finalReportDate,
    text: buildDailyReport({
      ...businessAnalysis,
      dayPlan,
      reportDate: finalReportDate,
    }),
  };
}

function parsePlanFactNew(rows) {
  const headerRow = rows[0] ?? [];
  const planRow = rows[1] ?? [];
  const summaryRows = rows.slice(0, 3);
  const findSummaryValue = (labelPattern) => {
    for (const row of summaryRows) {
      const labelIndex = row.findIndex((cell) => labelPattern.test(String(cell ?? '').trim()));
      if (labelIndex < 0) continue;

      for (let index = labelIndex + 1; index < row.length; index += 1) {
        const value = String(row[index] ?? '').trim();
        if (value && (parseMoney(value) || value.includes('%'))) {
          return value;
        }
      }
    }

    return '';
  };
  const factValue = [...headerRow]
    .reverse()
    .find((cell) => parseMoney(cell) >= 1000) ?? '';
  const completionValue = summaryRows
    .flat()
    .find((cell) => /^\s*[\d\s]+(?:[,.]\d+)?%\s*$/.test(String(cell ?? ''))) ?? '';
  const dailyPlans = rows.slice(4)
    .map((row) => ({
      date: parseSheetDate(row[0]),
      sourceDate: String(row[0] ?? '').trim(),
      dailyPlan: parseMoney(row[1]),
      fact: parseMoney(row[2]),
      completionPercent: parsePercent(row[3]),
    }))
    .filter((row) => row.date);

  return {
    monthName: String(headerRow[0] ?? '').trim(),
    reportDate: '',
    factFromPlanSheet: parseMoney(factValue),
    completionFromPlanSheet: parsePercent(completionValue),
    monthlyPlan: parseMoney(planRow[1]),
    remainingFromPlanSheet: parseMoney(findSummaryValue(/до плана/i)),
    dailyPlans,
  };
}

async function getSalesAnalysis(options = {}) {
  const auth = await getAuthenticatedClient();
  const sheets = new sheets_v4.Sheets({ auth });
  const valuesResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SALES_SHEET_TITLE.replaceAll("'", "''")}'!A:AJ`,
  });

  const salesRows = valuesResponse.data.values ?? [];
  return {
    ...analyzeSalesRows(salesRows, options),
    monthChoices: getMonthChoices(salesRows),
  };
}

async function getBusinessAnalysis(options = {}) {
  const auth = await getAuthenticatedClient();
  const sheets = new sheets_v4.Sheets({ auth });
  const [salesResponse, metadataResponse] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SALES_SHEET_TITLE.replaceAll("'", "''")}'!A:AJ`,
    }),
    sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets(properties(title))',
    }),
  ]);

  const salesRows = salesResponse.data.values ?? [];
  const monthChoices = getMonthChoices(salesRows);
  const dateMonth = options.date
    ? getSalesRows(salesRows).rows.find((row) => row.date === options.date)?.month
    : '';
  if (options.month) assertValidMonth(options.month);
  const requestedMonthKey = options.month
    || getSalesRows(salesRows).rows.find((row) => row.month === dateMonth)?.date?.slice(0, 7)
    || monthChoices[0]?.key
    || '';
  const selectedMonth = monthChoices.find(({ key }) => key === requestedMonthKey)?.label
    || requestedMonthKey;
  const sheetTitles = (metadataResponse.data.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter(Boolean);
  const planSheetTitle = findPlanSheetTitle(selectedMonth, sheetTitles);
  const planFactResponse = planSheetTitle
    ? await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${planSheetTitle.replaceAll("'", "''")}'!A1:F80`,
    })
    : { data: { values: [] } };

  return {
    analysis: {
      ...analyzeSalesRows(salesRows, { ...options, month: selectedMonth }),
      monthChoices,
    },
    plan: {
      ...parsePlanFactNew(planFactResponse.data.values ?? []),
      sheetTitle: planSheetTitle,
    },
    selectedMonth,
    selectedMonthKey: requestedMonthKey,
  };
}

async function refreshSheetsCache() {
  if (sheetsCache.refreshPromise) return sheetsCache.refreshPromise;

  sheetsCache.refreshPromise = Promise.all([
    getBusinessAnalysis(),
    getSalesAnalysis(),
  ])
    .then(([business, sales]) => {
      sheetsCache.business = business;
      sheetsCache.sales = sales;
      sheetsCache.updatedAt = new Date().toISOString();
      sheetsCache.lastError = null;
      return sheetsCache;
    })
    .catch((error) => {
      sheetsCache.lastError = error.message || String(error);
      throw error;
    })
    .finally(() => {
      sheetsCache.refreshPromise = null;
    });

  return sheetsCache.refreshPromise;
}

async function getCachedBusinessAnalysis(month = '') {
  if (month) return getBusinessAnalysis({ month });
  if (!sheetsCache.business) await refreshSheetsCache();
  return sheetsCache.business;
}

async function getBusinessDashboardData(month = '') {
  if (month) assertValidMonth(month);
  assertUmagConfigured();
  const business = await getCachedBusinessAnalysis(month);
  if (!business.selectedMonthKey) {
    throw new UmagError('No month is available for the business dashboard.', {
      code: 'MONTH_NOT_AVAILABLE',
      status: 400,
    });
  }

  return {
    ...business,
    umag: await getUmagMetrics(business.selectedMonthKey),
  };
}

async function getCachedSalesAnalysis(options = {}) {
  if (options.monthKey || options.dateFrom || options.dateTo) {
    return getSalesAnalysis(options);
  }
  if (!sheetsCache.sales) await refreshSheetsCache();
  return sheetsCache.sales;
}

app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>Drive Optimizer OAuth MVP</h1>
    <p><a href="/auth/google">Connect Google Drive</a></p>
    <p>After connecting, open <a href="/drive/files">/drive/files</a>.</p>
    <p>Sales dashboard: <a href="/dashboard">/dashboard</a>.</p>
    <p>Business analytics: <a href="/business">/business</a>.</p>
  `);
});

app.get('/health', (_req, res) => {
  res.json({
    status: sheetsCache.lastError ? 'degraded' : 'ok',
    sheetsUpdatedAt: sheetsCache.updatedAt,
    syncIntervalMs: SHEETS_SYNC_INTERVAL_MS,
    lastSyncError: sheetsCache.lastError,
  });
});

app.get('/auth/google', (_req, res) => {
  const state = createOAuthState();

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    include_granted_scopes: true,
    prompt: 'consent',
    scope: scopes,
    state,
  });

  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      res.status(400).send(`Google OAuth error: ${error}`);
      return;
    }

    if (!code || typeof code !== 'string') {
      res.status(400).send('Missing OAuth code.');
      return;
    }

    if (!state || typeof state !== 'string' || !isValidOAuthState(state)) {
      res.status(400).send('Invalid OAuth state.');
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);
    await saveToken(tokens);

    res.type('html').send(`
      <h1>Google Drive connected</h1>
      <p>Token saved locally for development.</p>
      <p><a href="/drive/files">View Drive files</a></p>
    `);
  } catch (err) {
    next(err);
  }
});

app.get('/drive/files', async (_req, res, next) => {
  try {
    const auth = await getAuthenticatedClient();
    const drive = new drive_v3.Drive({ auth });

    const { data } = await drive.files.list({
      pageSize: 25,
      fields: `files(${driveFileFields})`,
      orderBy: 'modifiedTime desc',
    });

    res.json({
      count: data.files?.length ?? 0,
      files: data.files?.map(normalizeFile) ?? [],
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.get('/drive/analyze', async (req, res, next) => {
  try {
    const auth = await getAuthenticatedClient();
    const drive = new drive_v3.Drive({ auth });
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const files = await listDriveFiles(drive, limit);

    res.json(analyzeDriveFiles(files));
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.get('/sheets/test-functional', async (_req, res, next) => {
  try {
    const auth = await getAuthenticatedClient();
    const sheets = new sheets_v4.Sheets({ auth });

    const metadataResponse = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))',
    });

    const spreadsheet = metadataResponse.data;
    const sheetSummaries = [];

    for (const sheet of spreadsheet.sheets ?? []) {
      const properties = sheet.properties;
      const title = properties.title;
      const columnCount = Math.min(properties.gridProperties?.columnCount ?? 26, 30);
      const range = `'${title.replaceAll("'", "''")}'!A1:${columnToLetter(columnCount)}200`;
      const valuesResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range,
      });

      sheetSummaries.push({
        sheetId: properties.sheetId,
        title,
        index: properties.index,
        rowCount: properties.gridProperties?.rowCount,
        columnCount: properties.gridProperties?.columnCount,
        ...summarizeSheetRows(valuesResponse.data.values ?? []),
      });
    }

    res.json({
      spreadsheetId: spreadsheet.spreadsheetId,
      title: spreadsheet.properties?.title,
      sheets: sheetSummaries,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.get('/sheets/test-functional/sales-analysis', async (_req, res, next) => {
  try {
    res.json(await getCachedSalesAnalysis());
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.get('/dashboard', async (req, res, next) => {
  try {
    const filters = getDashboardFilters(req.query);
    const analysis = await getCachedSalesAnalysis({
      monthKey: filters.month,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    });
    res.type('html').send(renderDashboard(analysis, filters));
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.get('/business.json', async (req, res, next) => {
  try {
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    res.json(await getBusinessDashboardData(month));
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.get('/business', async (req, res, next) => {
  try {
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    const businessAnalysis = await getBusinessDashboardData(month);
    res.type('html').send(renderBusinessDashboard(businessAnalysis));
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.get('/telegram/daily-report/preview', async (req, res, next) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const report = await getDailyReport({ date });

    res.type('text/plain').send(report.text);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.get('/telegram/daily-report/send', async (req, res, next) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : '';
    const report = await getDailyReport({ date });
    const telegramResponse = await sendTelegramMessage(report.text);

    res.json({
      sent: true,
      messageId: telegramResponse.result?.message_id,
      chatId: telegramResponse.result?.chat?.id,
      text: report.text,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.get('/telegram/command-test', async (req, res, next) => {
  try {
    const text = typeof req.query.text === 'string' ? req.query.text : '/help';
    const responseText = await buildTelegramCommandResponse(text);

    res.type('text/plain').send(responseText);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(401).json({
        error: 'Google Drive is not connected yet.',
        connectUrl: '/auth/google',
      });
      return;
    }

    next(err);
  }
});

app.post('/telegram/webhook', async (req, res, next) => {
  try {
    const message = req.body?.message;
    const text = message?.text;
    const chatId = message?.chat?.id;

    if (!text || !chatId) {
      res.json({ ok: true, ignored: true });
      return;
    }

    const responseText = await buildTelegramCommandResponse(text);
    const telegramResponse = await sendTelegramMessage(responseText, chatId);

    res.json({
      ok: true,
      messageId: telegramResponse.result?.message_id,
    });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err instanceof UmagError
    ? `UMAG request failed [${err.code}]: ${err.message}`
    : err);

  if (err instanceof UmagError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }

  if (err?.message === 'invalid_grant' || err?.response?.data?.error === 'invalid_grant') {
    res.status(401).type('html').send(`
      <!doctype html>
      <html lang="ru">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Нужно подключить Google</title>
          <style>
            body {
              min-height: 100vh;
              margin: 0;
              display: grid;
              place-items: center;
              color: #17130f;
              font-family: system-ui, sans-serif;
              background: #fff8ef;
            }
            main {
              width: min(520px, calc(100% - 40px));
              padding: 36px;
              border: 1px solid #ded3c7;
              border-radius: 24px;
              background: white;
              box-shadow: 0 24px 80px rgba(53, 38, 24, 0.12);
            }
            h1 { margin-top: 0; }
            p { color: #6d6258; line-height: 1.55; }
            a {
              display: inline-block;
              margin-top: 12px;
              padding: 12px 18px;
              border-radius: 12px;
              color: white;
              background: #1d6f5f;
              text-decoration: none;
              font-weight: 700;
            }
          </style>
        </head>
        <body>
          <main>
            <h1>Переподключите Google</h1>
            <p>Сохранённая авторизация истекла или была отозвана. Подключите аккаунт ещё раз, чтобы загрузить данные из Google Sheets.</p>
            <a href="/auth/google">Подключить Google</a>
          </main>
        </body>
      </html>
    `);
    return;
  }

  res.status(err?.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Drive Optimizer OAuth MVP listening on http://localhost:${PORT}`);

  refreshSheetsCache()
    .then(() => console.log(`Google Sheets cache updated at ${sheetsCache.updatedAt}`))
    .catch((error) => console.error('Initial Google Sheets sync failed:', error.message));

  const syncTimer = setInterval(() => {
    refreshSheetsCache()
      .then(() => console.log(`Google Sheets cache updated at ${sheetsCache.updatedAt}`))
      .catch((error) => console.error('Scheduled Google Sheets sync failed:', error.message));
  }, SHEETS_SYNC_INTERVAL_MS);

  syncTimer.unref();
});
