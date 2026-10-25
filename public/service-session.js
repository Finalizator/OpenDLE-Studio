import { readServiceResponse } from './service-response.js';

export async function requestWithSession(path, options, token, fetchImpl = fetch) {
  const request = () => fetchImpl(path, { ...options, headers: {
    'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${token}`,
  } });
  let response = await request();
  if (response.status === 401) {
    const session = await readServiceResponse(await fetchImpl('/api/session', { cache: 'no-store' }), '/api/session');
    if (typeof session.token !== 'string' || !session.token) throw new Error('Local service returned an invalid session token');
    token = session.token;
    response = await request();
  }
  return { response, token };
}
