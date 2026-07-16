const https = require('node:https');

const APP_UPDATES_URL = 'https://henley04.github.io/SXSEditor/user/app-updates.html';
const MODEL_UPDATES_URL = 'https://henley04.github.io/SXSEditor/user/model-updates.html';
const REQUEST_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const htmlCache = new Map();

/**
 * Fetch HTML content from a URL with timeout and simple in-memory caching.
 */
function fetchHtml(url) {
  const cached = htmlCache.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return Promise.resolve(cached.html);
  }
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: { 'User-Agent': 'SXSEditor-Updater' },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf-8');
        htmlCache.set(url, { html, time: Date.now() });
        resolve(html);
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Release notes fetch timeout'));
    });
    req.end();
  });
}

/**
 * Extract the inner HTML of the first <span data-lang="lang">...</span> in the given text.
 */
function extractSpanInner(html, lang) {
  const regex = new RegExp(`<span[^>]*data-lang="${lang}"[^>]*>([\\s\\S]*?)</span>`, 'i');
  const m = html.match(regex);
  return m ? m[1].trim() : null;
}

/**
 * Normalize a version string for prefix matching.
 * Strips leading 'v' and trims whitespace.
 */
function normalizeVersion(v) {
  if (!v) return '';
  return v.replace(/^v/i, '').trim();
}

/**
 * Extract structured content for a specific version from an updates HTML page.
 *
 * Returns:
 *   { found: true, version: 'v1.0.5', sections: [...], intro: {...}|null }
 *   or null if the version block was not found.
 *
 * Each section: { title: { en, zh }, items: [{ en, zh }, ...] }
 * intro: { en, zh } | null
 */
function extractVersionContent(html, versionPrefix) {
  const normalizedPrefix = normalizeVersion(versionPrefix);
  if (!normalizedPrefix) return null;

  // Find all <h2>...</h2> blocks
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/g;
  const h2Matches = [];
  let m;
  while ((m = h2Regex.exec(html)) !== null) {
    h2Matches.push({ start: m.index, end: m.index + m[0].length, content: m[1] });
  }

  for (let i = 0; i < h2Matches.length; i++) {
    const h2 = h2Matches[i];
    const enVersion = extractSpanInner(h2.content, 'en');
    const zhVersion = extractSpanInner(h2.content, 'zh');

    const enNorm = normalizeVersion(enVersion);
    const zhNorm = normalizeVersion(zhVersion);

    const matches =
      enNorm === normalizedPrefix ||
      zhNorm === normalizedPrefix ||
      enNorm.startsWith(normalizedPrefix) ||
      zhNorm.startsWith(normalizedPrefix);

    if (!matches) continue;

    // Determine content range: from end of this <h2> to start of next <h2> (or <nav>)
    const contentStart = h2.end;
    let contentEnd = i + 1 < h2Matches.length ? h2Matches[i + 1].start : html.length;
    let content = html.substring(contentStart, contentEnd);

    // Cut off at <nav (the pager at the bottom)
    const navIdx = content.indexOf('<nav');
    if (navIdx !== -1) content = content.substring(0, navIdx);

    const parsed = parseContent(content);
    return {
      found: true,
      version: enVersion || zhVersion || versionPrefix,
      sections: parsed.sections,
      intro: parsed.intro,
    };
  }

  return null;
}

/**
 * Parse the content under a version <h2> into sections and intro.
 */
function parseContent(content) {
  const sections = [];
  let intro = null;

  // Extract intro paragraphs (<p data-lang="en">...</p><p data-lang="zh">...</p>)
  const pEnMatch = content.match(/<p[^>]*data-lang="en"[^>]*>([\s\S]*?)<\/p>/i);
  const pZhMatch = content.match(/<p[^>]*data-lang="zh"[^>]*>([\s\S]*?)<\/p>/i);
  if (pEnMatch || pZhMatch) {
    intro = {
      en: pEnMatch ? pEnMatch[1].trim() : null,
      zh: pZhMatch ? pZhMatch[1].trim() : null,
    };
  }

  // Extract <h3>...</h3> followed by <ul>...</ul>
  const h3UlRegex = /<h3[^>]*>([\s\S]*?)<\/h3>\s*(<ul[^>]*>[\s\S]*?<\/ul>)/g;
  let h3Match;
  while ((h3Match = h3UlRegex.exec(content)) !== null) {
    const h3Content = h3Match[1];
    const ulContent = h3Match[2];
    sections.push({
      title: {
        en: extractSpanInner(h3Content, 'en'),
        zh: extractSpanInner(h3Content, 'zh'),
      },
      items: parseListItems(ulContent),
    });
  }

  // If no <h3> sections found, look for standalone <ul> (model-updates style)
  if (sections.length === 0) {
    const ulRegex = /<ul[^>]*>([\s\S]*?)<\/ul>/g;
    let ulMatch;
    while ((ulMatch = ulRegex.exec(content)) !== null) {
      const items = parseListItems(ulMatch[1]);
      if (items.length > 0) {
        sections.push({ title: { en: null, zh: null }, items });
      }
    }
  }

  return { sections, intro };
}

/**
 * Parse <li> items from a <ul> block. Each <li> contains paired
 * <span data-lang="en">...</span><span data-lang="zh">...</span>.
 */
function parseListItems(ulContent) {
  const items = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/g;
  let liMatch;
  while ((liMatch = liRegex.exec(ulContent)) !== null) {
    const liContent = liMatch[1];
    const en = extractSpanInner(liContent, 'en');
    const zh = extractSpanInner(liContent, 'zh');
    if (en || zh) {
      items.push({ en, zh });
    }
  }
  return items;
}

/**
 * Fetch and extract app release notes for a specific version from the official docs site.
 * Returns structured content or null on failure.
 */
async function fetchAppReleaseNotes(version) {
  try {
    const html = await fetchHtml(APP_UPDATES_URL);
    return extractVersionContent(html, version);
  } catch (err) {
    console.warn('[ReleaseNotes] Failed to fetch app release notes:', err.message);
    return null;
  }
}

/**
 * Fetch and extract model release notes for a specific version from the official docs site.
 * Returns structured content or null on failure.
 */
async function fetchModelReleaseNotes(version) {
  try {
    const html = await fetchHtml(MODEL_UPDATES_URL);
    return extractVersionContent(html, version);
  } catch (err) {
    console.warn('[ReleaseNotes] Failed to fetch model release notes:', err.message);
    return null;
  }
}

module.exports = {
  fetchAppReleaseNotes,
  fetchModelReleaseNotes,
  // Exported for testing
  _extractVersionContent: extractVersionContent,
  _parseListItems: parseListItems,
  _extractSpanInner: extractSpanInner,
};
