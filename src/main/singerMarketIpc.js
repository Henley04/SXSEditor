/**
 * Singer Market IPC handlers.
 *
 * Acts as a thin proxy between the Singer Market renderer window and the
 * Cloudflare Workers backend (singer-files.15240287482.workers.dev).
 *
 * All HTTP requests are made from the main process (using Node's `https` /
 * `http` modules) rather than the renderer so that:
 *   1. CSP `connect-src 'self'` does not need to be widened.
 *   2. The Bearer token never enters any renderer's JavaScript context.
 *   3. File uploads can stream directly from disk for large .sxssinger files.
 *
 * Tokens (sfu_*, sf_*) are persisted to userData/singer-market-token.json so
 * the user stays logged in across launches. The file is created with mode
 * 0o600 (owner read/write only) on POSIX systems.
 */

const { ipcMain, app } = require('electron');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const API_BASE = 'https://singer-files.15240287482.workers.dev';
const TOKEN_FILE = path.join(app.getPath('userData'), 'singer-market-token.json');

// In-memory cache of the current session token + user info.
let _session = null;

function loadSession() {
  if (_session) return _session;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
      _session = JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[SingerMarket] Failed to load saved session:', err.message);
  }
  return _session;
}

function saveSession(session) {
  _session = session;
  try {
    // Persist with mode 0o600 on POSIX. On Windows the mode is ignored.
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn('[SingerMarket] Failed to persist session:', err.message);
  }
}

function clearSession() {
  _session = null;
  try {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
  } catch (err) {
    console.warn('[SingerMarket] Failed to remove session file:', err.message);
  }
}

function getToken() {
  const s = loadSession();
  return s ? s.token : null;
}

/**
 * Perform an HTTP/HTTPS request and resolve to { status, headers, body }.
 * `body` is a string for textual responses, or a Buffer for binary responses
 * (when `encoding` is null).
 */
function request(method, urlPath, { headers = {}, body = null, encoding = 'utf-8' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + urlPath);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const finalHeaders = { ...headers };
    let bodyBuf = null;

    if (body != null) {
      if (Buffer.isBuffer(body)) {
        bodyBuf = body;
      } else if (typeof body === 'string') {
        bodyBuf = Buffer.from(body, 'utf-8');
      } else {
        bodyBuf = Buffer.from(JSON.stringify(body), 'utf-8');
        if (!finalHeaders['Content-Type']) {
          finalHeaders['Content-Type'] = 'application/json';
        }
      }
      finalHeaders['Content-Length'] = bodyBuf.length;
    }

    const reqOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: finalHeaders,
    };

    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (encoding === null) {
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        } else {
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString(encoding) });
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Add the Bearer token to the headers if a session exists.
 */
function withAuth(headers = {}) {
  const token = getToken();
  if (token) {
    return { ...headers, Authorization: `Bearer ${token}` };
  }
  return headers;
}

/**
 * Parse a JSON response body, returning null on parse failure.
 */
function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

/**
 * Build a multipart/form-data body from fields and an optional file.
 * Returns { body: Buffer, contentType: string }.
 */
function buildMultipart(fields, file) {
  const boundary = '----SingerMarketBoundary' + Math.random().toString(16).slice(2);
  const parts = [];

  for (const [name, value] of Object.entries(fields)) {
    if (value == null) continue;
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    parts.push(Buffer.from(String(value) + '\r\n'));
  }

  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(
      `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`
    ));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function registerSingerMarketIpc() {
  // ----- Auth -----
  ipcMain.handle('singer-market:register', async (event, { username, password }) => {
    try {
      const res = await request('POST', '/api/auth/register', {
        body: { username, password },
      });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300 && data.token) {
        saveSession({ token: data.token, user: data.user });
        return { success: true, user: data.user };
      }
      return { success: false, error: data.error || `Registration failed (HTTP ${res.status})` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('singer-market:login', async (event, { username, password }) => {
    try {
      const res = await request('POST', '/api/auth/login', {
        body: { username, password },
      });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300 && data.token) {
        saveSession({ token: data.token, user: data.user });
        return { success: true, user: data.user };
      }
      return { success: false, error: data.error || `Login failed (HTTP ${res.status})` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('singer-market:logout', async () => {
    try {
      await request('POST', '/api/auth/logout', { headers: withAuth() });
    } catch (_) {
      // Ignore network errors — we clear the local session regardless.
    }
    clearSession();
    return { success: true };
  });

  ipcMain.handle('singer-market:me', async () => {
    if (!getToken()) return { success: false, user: null };
    try {
      const res = await request('GET', '/api/auth/me', { headers: withAuth() });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300 && data.user) {
        // Update cached user info
        const session = loadSession();
        if (session) {
          saveSession({ ...session, user: data.user });
        }
        return { success: true, user: data.user };
      }
      if (res.status === 401) {
        // Token expired/revoked — clear local session.
        clearSession();
      }
      return { success: false, user: null };
    } catch (err) {
      return { success: false, user: null, error: err.message };
    }
  });

  // ----- File listing / search / filter -----
  ipcMain.handle('singer-market:list', async (event, params = {}) => {
    try {
      const query = new URLSearchParams();
      // Only show public files for browsing (private files only visible to owner)
      query.set('visibility', 'public');
      if (params.tags && Array.isArray(params.tags) && params.tags.length > 0) {
        query.set('tags', params.tags.join(','));
        query.set('tag_mode', params.tag_mode || 'and');
      }
      if (params.q) query.set('q', params.q);
      if (params.page) query.set('page', String(params.page));
      if (params.limit) query.set('limit', String(params.limit));

      const res = await request('GET', `/api/files?${query.toString()}`);
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: data.error || `List failed (HTTP ${res.status})` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('singer-market:file-detail', async (event, fileId) => {
    try {
      const res = await request('GET', `/api/files/${encodeURIComponent(fileId)}`, {
        headers: withAuth(),
      });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: data.error || `Fetch failed (HTTP ${res.status})` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ----- Tags -----
  ipcMain.handle('singer-market:tags', async (event, params = {}) => {
    try {
      const query = new URLSearchParams();
      if (params.q) query.set('q', params.q);
      if (params.suggest) query.set('suggest', '1');
      if (params.exact) query.set('exact', '1');
      if (params.limit) query.set('limit', String(params.limit));

      const res = await request('GET', `/api/tags?${query.toString()}`);
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: data.error || `Tags fetch failed (HTTP ${res.status})` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ----- Upload -----
  ipcMain.handle('singer-market:upload', async (event, payload) => {
    if (!getToken()) {
      return { success: false, error: 'Not logged in' };
    }
    try {
      const { filePath, description, tags, visibility } = payload;
      if (!filePath) return { success: false, error: 'Missing file path' };

      // Read the file from disk (renderer supplied path via showOpenDialog)
      const fs = require('node:fs');
      const fileBuf = await fs.promises.readFile(filePath);
      const filename = path.basename(filePath);

      const fields = {};
      if (description) fields.description = description;
      if (tags) fields.tags = tags;
      if (visibility) fields.visibility = visibility;

      const { body, contentType } = buildMultipart(fields, {
        filename,
        data: fileBuf,
        contentType: 'application/octet-stream',
      });

      const res = await request('POST', '/api/files', {
        headers: withAuth({ 'Content-Type': contentType }),
        body,
      });
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: data.error || `Upload failed (HTTP ${res.status})` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ----- Download -----
  // Returns the raw file bytes + suggested filename. The renderer is
  // responsible for prompting the user for a save location and writing the
  // file to disk via the existing file:saveFile IPC.
  ipcMain.handle('singer-market:download', async (event, fileId) => {
    try {
      const res = await request('GET', `/api/files/${encodeURIComponent(fileId)}/download`, {
        headers: withAuth(),
        encoding: null,
      });
      if (res.status >= 200 && res.status < 300) {
        // Try to extract a filename from Content-Disposition
        const cd = res.headers['content-disposition'] || '';
        let filename = 'singer.sxssinger';
        const match = cd.match(/filename="?([^";]+)"?/i);
        if (match) filename = match[1];
        return {
          success: true,
          data: {
            buffer: res.body.buffer.slice(
              res.body.byteOffset,
              res.body.byteOffset + res.body.byteLength
            ),
            filename,
            contentType: res.headers['content-type'] || 'application/octet-stream',
          },
        };
      }
      let errorMsg = `Download failed (HTTP ${res.status})`;
      try {
        const errBody = JSON.parse(res.body.toString('utf-8'));
        if (errBody.error) errorMsg = errBody.error;
      } catch (_) {}
      return { success: false, error: errorMsg };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ----- Pick .sxssinger file for upload (uses native dialog) -----
  ipcMain.handle('singer-market:pick-file', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      title: 'Select a .sxssinger file',
      filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const filePath = result.filePaths[0];
    // Authorize the path so file:readFileBuffer etc. work later if needed.
    try {
      const { authorizePath } = require('./security');
      authorizePath(filePath);
    } catch (_) {}
    return { success: true, filePath, filename: path.basename(filePath) };
  });

  // ----- Pick save destination for downloaded .sxssinger file -----
  ipcMain.handle('singer-market:pick-save-path', async (event, suggestedName) => {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog({
      title: 'Save Singer File',
      defaultPath: suggestedName || 'singer.sxssinger',
      filters: [{ name: 'SXS Singer', extensions: ['sxssinger'] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    // Authorize the path so file:saveFile works.
    try {
      const { authorizePath } = require('./security');
      authorizePath(result.filePath);
    } catch (_) {}
    return { success: true, filePath: result.filePath };
  });

  // ----- Get server health -----
  ipcMain.handle('singer-market:health', async () => {
    try {
      const res = await request('GET', '/health');
      const data = tryParseJson(res.body) || {};
      if (res.status >= 200 && res.status < 300) {
        return { success: true, data };
      }
      return { success: false, error: `Health check failed (HTTP ${res.status})` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerSingerMarketIpc,
  // Exported for testing
  _internal: { request, buildMultipart, withAuth, loadSession, saveSession, clearSession },
};
