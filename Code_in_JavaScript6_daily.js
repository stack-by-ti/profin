
function md5(str) {
  const rotl = (l, s) => (l << s) | (l >>> (32 - s));
  const add = (x, y) => ((x + y) & 0xFFFFFFFF) >>> 0;
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => x ^ y ^ z;
  const I = (x, y, z) => y ^ (x | ~z);
  const FF = (a, b, c, d, x, s, ac) => add(rotl(add(add(a, F(b, c, d)), add(x, ac)), s), b);
  const GG = (a, b, c, d, x, s, ac) => add(rotl(add(add(a, G(b, c, d)), add(x, ac)), s), b);
  const HH = (a, b, c, d, x, s, ac) => add(rotl(add(add(a, H(b, c, d)), add(x, ac)), s), b);
  const II = (a, b, c, d, x, s, ac) => add(rotl(add(add(a, I(b, c, d)), add(x, ac)), s), b);
  const u8 = unescape(encodeURIComponent(str));
  const len = u8.length;
  const nWords = (((len + 8) >> 6) + 1) << 4;
  const X = new Array(nWords).fill(0);
  for (let i = 0; i < len; i++) X[i >> 2] |= u8.charCodeAt(i) << ((i % 4) * 8);
  X[len >> 2] |= 0x80 << ((len % 4) * 8);
  X[nWords - 2] = len * 8;
  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
  for (let i = 0; i < X.length; i += 16) {
    const [aa, bb, cc, dd] = [a, b, c, d];
    a = FF(a, b, c, d, X[i + 0], 7, 0xD76AA478); d = FF(d, a, b, c, X[i + 1], 12, 0xE8C7B756);
    c = FF(c, d, a, b, X[i + 2], 17, 0x242070DB); b = FF(b, c, d, a, X[i + 3], 22, 0xC1BDCEEE);
    a = FF(a, b, c, d, X[i + 4], 7, 0xF57C0FAF); d = FF(d, a, b, c, X[i + 5], 12, 0x4787C62A);
    c = FF(c, d, a, b, X[i + 6], 17, 0xA8304613); b = FF(b, c, d, a, X[i + 7], 22, 0xFD469501);
    a = FF(a, b, c, d, X[i + 8], 7, 0x698098D8); d = FF(d, a, b, c, X[i + 9], 12, 0x8B44F7AF);
    c = FF(c, d, a, b, X[i + 10], 17, 0xFFFF5BB1); b = FF(b, c, d, a, X[i + 11], 22, 0x895CD7BE);
    a = FF(a, b, c, d, X[i + 12], 7, 0x6B901122); d = FF(d, a, b, c, X[i + 13], 12, 0xFD987193);
    c = FF(c, d, a, b, X[i + 14], 17, 0xA679438E); b = FF(b, c, d, a, X[i + 15], 22, 0x49B40821);
    a = GG(a, b, c, d, X[i + 1], 5, 0xF61E2562); d = GG(d, a, b, c, X[i + 6], 9, 0xC040B340);
    c = GG(c, d, a, b, X[i + 11], 14, 0x265E5A51); b = GG(b, c, d, a, X[i + 0], 20, 0xE9B6C7AA);
    a = GG(a, b, c, d, X[i + 5], 5, 0xD62F105D); d = GG(d, a, b, c, X[i + 10], 9, 0x02441453);
    c = GG(c, d, a, b, X[i + 15], 14, 0xD8A1E681); b = GG(b, c, d, a, X[i + 4], 20, 0xE7D3FBC8);
    a = GG(a, b, c, d, X[i + 9], 5, 0x21E1CDE6); d = GG(d, a, b, c, X[i + 14], 9, 0xC33707D6);
    c = GG(c, d, a, b, X[i + 3], 14, 0xF4D50D87); b = GG(b, c, d, a, X[i + 8], 20, 0x455A14ED);
    a = GG(a, b, c, d, X[i + 13], 5, 0xA9E3E905); d = GG(d, a, b, c, X[i + 2], 9, 0xFCEFA3F8);
    c = GG(c, d, a, b, X[i + 7], 14, 0x676F02D9); b = GG(b, c, d, a, X[i + 12], 20, 0x8D2A4C8A);
    a = HH(a, b, c, d, X[i + 5], 4, 0xFFFA3942); d = HH(d, a, b, c, X[i + 8], 11, 0x8771F681);
    c = HH(c, d, a, b, X[i + 11], 16, 0x6D9D6122); b = HH(b, c, d, a, X[i + 14], 23, 0xFDE5380C);
    a = HH(a, b, c, d, X[i + 1], 4, 0xA4BEEA44); d = HH(d, a, b, c, X[i + 4], 11, 0x4BDECFA9);
    c = HH(c, d, a, b, X[i + 7], 16, 0xF6BB4B60); b = HH(b, c, d, a, X[i + 10], 23, 0xBEBFBC70);
    a = HH(a, b, c, d, X[i + 13], 4, 0x289B7EC6); d = HH(d, a, b, c, X[i + 0], 11, 0xEAA127FA);
    c = HH(c, d, a, b, X[i + 3], 16, 0xD4EF3085); b = HH(b, c, d, a, X[i + 6], 23, 0x04881D05);
    a = HH(a, b, c, d, X[i + 9], 4, 0xD9D4D039); d = HH(d, a, b, c, X[i + 12], 11, 0xE6DB99E5);
    c = HH(c, d, a, b, X[i + 15], 16, 0x1FA27CF8); b = HH(b, c, d, a, X[i + 2], 23, 0xC4AC5665);
    a = II(a, b, c, d, X[i + 0], 6, 0xF4292244); d = II(d, a, b, c, X[i + 7], 10, 0x432AFF97);
    c = II(c, d, a, b, X[i + 14], 15, 0xAB9423A7); b = II(b, c, d, a, X[i + 5], 21, 0xFC93A039);
    a = II(a, b, c, d, X[i + 12], 6, 0x655B59C3); d = II(d, a, b, c, X[i + 3], 10, 0x8F0CCC92);
    c = II(c, d, a, b, X[i + 10], 15, 0xFFEFF47D); b = II(b, c, d, a, X[i + 1], 21, 0x85845DD1);
    a = II(a, b, c, d, X[i + 8], 6, 0x6FA87E4F); d = II(d, a, b, c, X[i + 15], 10, 0xFE2CE6E0);
    c = II(c, d, a, b, X[i + 6], 15, 0xA3014314); b = II(b, c, d, a, X[i + 13], 21, 0x4E0811A1);
    a = II(a, b, c, d, X[i + 4], 6, 0xF7537E82); d = II(d, a, b, c, X[i + 11], 10, 0xBD3AF235);
    c = II(c, d, a, b, X[i + 2], 15, 0x2AD7D2BB); b = II(b, c, d, a, X[i + 9], 21, 0xEB86D391);
    a = add(a, aa); b = add(b, bb); c = add(c, cc); d = add(d, dd);
  }
  const hexLE = (w) =>
    ('0' + (w & 0xFF).toString(16)).slice(-2) +
    ('0' + ((w >> 8) & 0xFF).toString(16)).slice(-2) +
    ('0' + ((w >> 16) & 0xFF).toString(16)).slice(-2) +
    ('0' + ((w >> 24) & 0xFF).toString(16)).slice(-2);
  return (hexLE(a) + hexLE(b) + hexLE(c) + hexLE(d)).toLowerCase();
}

function digestHeader(wwwAuth, username, password, method, uri) {
  const realm = /realm="([^"]+)"/.exec(wwwAuth)?.[1];
  const nonce = /nonce="([^"]+)"/.exec(wwwAuth)?.[1];
  const qop = /qop="?([^",]+)"?/.exec(wwwAuth)?.[1] ?? 'auth';
  if (!realm || !nonce) throw new Error('Digest challenge is missing realm or nonce');
  const nc = '00000001';
  const cnonce = Math.random().toString(36).slice(2, 10);
  const ha1 = md5(username + ':' + realm + ':' + password);
  const ha2 = md5(method + ':' + uri);
  const response = md5(ha1 + ':' + nonce + ':' + nc + ':' + cnonce + ':' + qop + ':' + ha2);
  return 'Digest username="' + username + '",realm="' + realm + '",nonce="' + nonce + '",uri="' + uri + '",algorithm="MD5",qop=' + qop + ',nc=' + nc + ',cnonce="' + cnonce + '",response="' + response + '"';
}

async function httpJson(options) {
  const response = await this.helpers.httpRequest({
    ...options,
    json: true,
    simple: false,
    resolveWithFullResponse: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
  });

  let body = response.body ?? null;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {}
  }

  return {
    statusCode: response.statusCode ?? response.status ?? 0,
    headers: response.headers ?? {},
    body,
  };
}

function getHeader(headers, name) {
  const target = name.toLowerCase();
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === target);
  return key ? headers[key] : null;
}

async function fetchAcsEventsPaged(deviceIp, { startTime, endTime, userId, searchPrefix }) {
  const username = 'admin';
  const password = 'WPvH93sqmY';
  const uri = '/ISAPI/AccessControl/AcsEvent?format=json';
  const url = 'http://' + deviceIp + uri;
  const pageSize = 200;
  const maxPages = 50;

  const challenge = await httpJson.call(this, { method: 'GET', url, headers: { Connection: 'keep-alive' } });
  const wwwAuth = getHeader(challenge.headers, 'www-authenticate');
  if (!wwwAuth) {
    throw new Error('Device ' + deviceIp + ' did not return digest challenge, status ' + challenge.statusCode);
  }

  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const position = page * pageSize;
    const body = {
      AcsEventCond: {
        searchID: searchPrefix + '_' + $execution.id + '_' + deviceIp + '_' + page,
        searchResultPosition: position,
        maxResults: pageSize,
        major: 5,
        minor: 75,
        startTime,
        endTime,
        employeeNoString: String(userId),
      },
    };

    const authHeader = digestHeader(wwwAuth, username, password, 'POST', uri);
    const resp = await httpJson.call(this, {
      method: 'POST',
      url,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (resp.statusCode >= 400) {
      throw new Error('Device ' + deviceIp + ' returned HTTP ' + resp.statusCode + ' at position ' + position);
    }

    const list = resp.body?.AcsEvent?.InfoList ?? [];
    all.push(...list);

    const total = Number(resp.body?.AcsEvent?.totalMatches ?? resp.body?.AcsEvent?.numOfMatches ?? NaN);
    if (list.length < pageSize) break;
    if (Number.isFinite(total) && position + list.length >= total) break;
  }

  return all;
}

function dayRanges(startTime, endTime) {
  const startDate = startTime.slice(0, 10);
  const endDate = endTime.slice(0, 10);
  const tz = startTime.slice(19) || '+05:00';

  const result = [];
  let d = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (d <= end) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const date = yyyy + '-' + mm + '-' + dd;

    result.push({
      date,
      startTime: date + 'T00:00:00' + tz,
      endTime: date + 'T23:59:59' + tz,
    });

    d.setUTCDate(d.getUTCDate() + 1);
  }

  return result;
}

const meta = $('Loop Over Items1').item.json ?? $json ?? {};
const deviceIp = meta.ip ?? meta.device_ip ?? null;
const params = $items('Code in JavaScript4')[0].json;

try {
  const allEvents = [];

  for (const range of dayRanges(params.startTime, params.endTime)) {
    const list = await fetchAcsEventsPaged.call(this, deviceIp, {
      startTime: range.startTime,
      endTime: range.endTime,
      userId: params.user_id,
      searchPrefix: 'out_' + range.date,
    });

    allEvents.push(...list);
  }

  const events = allEvents.filter((e) =>
    e.major === 5 &&
    e.minor === 75 &&
    e.time &&
    String(e.employeeNoString) === String(params.user_id)
  );

  if (!events.length) {
    return [{
      json: {
        status: 'no_data',
        message: 'На выходном домофоне нет событий за выбранный период',
        device_ip: deviceIp,
        days: [],
        pages_mode: 'daily',
        raw_events: 0,
      },
    }];
  }

  const byDay = {};
  for (const e of events) {
    const date = e.time.slice(0, 10);
    if (!byDay[date]) byDay[date] = [];
    byDay[date].push(e);
  }

  const days = Object.entries(byDay).map(([date, arr]) => {
    let last = arr[0];
    let maxMs = new Date(last.time).getTime();

    for (const e of arr) {
      const ms = new Date(e.time).getTime();
      if (ms > maxMs) {
        last = e;
        maxMs = ms;
      }
    }

    return {
      date,
      last_out: last.time,
      employee_id: last.employeeNoString ?? null,
      name: last.name ?? null,
      outIp: deviceIp,
    };
  });

  return [{
    json: {
      status: 'ok',
      message: 'OK',
      device_ip: deviceIp,
      days,
      pages_mode: 'daily',
      raw_events: events.length,
    },
  }];
} catch (error) {
  return [{
    json: {
      status: 'device_error',
      message: error.message,
      device_ip: deviceIp,
      days: [],
    },
  }];
}
