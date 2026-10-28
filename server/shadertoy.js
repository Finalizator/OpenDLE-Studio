// Importing a shader from a Shadertoy link.
//
// Shadertoy serves its shader source inside the page, so this fetches the page the way a
// browser would and lifts the code out of it. The site sits behind a bot challenge, which
// means the read can fail from a machine it does not trust; the caller reports that and
// asks for a paste instead of pretending the link was broken.

const SHADER_ID = /^[A-Za-z0-9]{6,12}$/;
const PAGE = id => `https://www.shadertoy.com/view/${id}`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.shadertoy.com/',
};

/** The shader id in a Shadertoy link, or null when the link is not one. */
export function shadertoyId(link) {
  const text = String(link || '').trim();
  const match = /shadertoy\.com\/(?:view|embed)\/([A-Za-z0-9]{6,12})/.exec(text) || /^([A-Za-z0-9]{6,12})$/.exec(text);
  return match && SHADER_ID.test(match[1]) ? match[1] : null;
}

/** Pulls the shader source and name out of a Shadertoy page. */
export function readShadertoyPage(html) {
  const text = String(html || '');
  if (/Just a moment|cf-browser-verification|challenge-platform/.test(text)) {
    throw new Error('Shadertoy answered with its bot challenge, so the shader could not be read automatically. Open the link, copy the code and paste it here.');
  }
  // The shader is embedded as JSON in the page: {"code":"...","name":"..."}.
  const code = /"code"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!code) throw new Error('That page did not contain shader code. Copy the code from Shadertoy and paste it here.');
  const name = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const decode = value => {
    try { return JSON.parse(`"${value}"`); } catch { return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
  };
  return { code: decode(code[1]), name: name ? decode(name[1]) : '' };
}

/** Fetches one Shadertoy shader by link or id. */
export async function fetchShadertoy(link, { fetchImpl = fetch } = {}) {
  const id = shadertoyId(link);
  if (!id) throw new Error('That is not a Shadertoy link; it looks like https://www.shadertoy.com/view/XXXXXXXX');
  const response = await fetchImpl(PAGE(id), { headers: HEADERS, redirect: 'follow' });
  if (!response.ok) throw new Error(`Shadertoy answered ${response.status} for ${id}. Copy the code from the page and paste it here instead.`);
  const html = await response.text();
  return { id, ...readShadertoyPage(html) };
}
