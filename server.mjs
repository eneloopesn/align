// 啟動：node server.mjs  →  http://127.0.0.1:4173
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const MAX_CHARS = 800;

const STATIC = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
  ['/favicon.svg', 'favicon.svg'],
]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, type) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': payload.length,
    'Cache-Control': 'no-cache',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 20_000) {
        reject(Object.assign(new Error('內容過長'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function usable(text) {
  const clean = (text || '').trim();
  if (!clean) return '';
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT EXCEEDED/i.test(clean)) return '';
  return clean;
}

async function translateGoogle(q, sl, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?${new URLSearchParams({
    client: 'gtx',
    sl,
    tl,
    dt: 't',
    dj: '1',
    q,
  })}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Google 翻譯回應 ${res.status}`);
  const data = await res.json();
  let text = '';
  if (data && Array.isArray(data.sentences)) {
    text = data.sentences.map((sentence) => sentence.trans || '').join('');
  } else if (Array.isArray(data?.[0])) {
    text = data[0].map((part) => part?.[0] || '').join('');
  }
  text = usable(text);
  if (!text) throw new Error('Google 翻譯沒有內容');
  return text;
}

async function translateMemory(q, sl, tl) {
  const url = `https://api.mymemory.translated.net/get?${new URLSearchParams({
    q,
    langpair: `${sl}|${tl}`,
  })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`備用翻譯回應 ${res.status}`);
  const data = await res.json();
  const direct = usable(decodeEntities(data?.responseData?.translatedText || ''));
  if (direct) return direct;
  const match = (data?.matches || []).find((item) => usable(item?.translation));
  const fallback = usable(decodeEntities(match?.translation || ''));
  if (!fallback) throw new Error('備用翻譯沒有內容');
  return fallback;
}

async function translate(q, sl, tl) {
  try {
    return { translation: await translateGoogle(q, sl, tl), provider: 'google' };
  } catch (error) {
    console.error('[align] Google 翻譯失敗：', error.message);
  }
  try {
    return { translation: await translateMemory(q, sl, tl), provider: 'mymemory' };
  } catch (error) {
    console.error('[align] 備用翻譯失敗：', error.message);
  }
  throw Object.assign(new Error('翻譯服務暫時無法連線'), { status: 502 });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  if (url.pathname === '/api/translate') {
    if (req.method !== 'POST') {
      send(res, 405, JSON.stringify({ error: '只接受 POST' }), 'application/json; charset=utf-8');
      return;
    }
    try {
      const payload = JSON.parse(await readBody(req) || '{}');
      const q = String(payload.q || '').trim();
      const sl = String(payload.sl || '').trim();
      const tl = String(payload.tl || '').trim();
      const langOk = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
      if (!q || q.length > MAX_CHARS) {
        send(res, 400, JSON.stringify({ error: '句子是空的，或超過長度限制' }), 'application/json; charset=utf-8');
        return;
      }
      if (!langOk.test(sl) || !langOk.test(tl)) {
        send(res, 400, JSON.stringify({ error: '語言代碼不正確' }), 'application/json; charset=utf-8');
        return;
      }
      if (sl === tl) {
        send(res, 200, JSON.stringify({ translation: q, provider: 'identity' }), 'application/json; charset=utf-8');
        return;
      }
      const result = await translate(q, sl, tl);
      send(res, 200, JSON.stringify(result), 'application/json; charset=utf-8');
    } catch (error) {
      const status = error.status || 400;
      send(res, status, JSON.stringify({ error: error.message || '翻譯失敗' }), 'application/json; charset=utf-8');
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, '不支援的方法', 'text/plain; charset=utf-8');
    return;
  }

  const fileName = STATIC.get(url.pathname);
  if (!fileName) {
    send(res, 404, '找不到頁面', 'text/plain; charset=utf-8');
    return;
  }

  try {
    const body = await readFile(join(ROOT, fileName));
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': TYPES[extname(fileName)] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end();
      return;
    }
    send(res, 200, body, TYPES[extname(fileName)] || 'application/octet-stream');
  } catch {
    send(res, 404, '找不到頁面', 'text/plain; charset=utf-8');
  }
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Align 同聲翻譯  http://127.0.0.1:${PORT}`);
});
