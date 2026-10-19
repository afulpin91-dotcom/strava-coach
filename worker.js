// Mini relais Cloudflare Workers (gratuit) : garde votre Client Secret et fait passer
// les appels Strava que le navigateur n'a pas le droit de faire directement (CORS).
// Il ne stocke rien. Variables à définir : CLIENT_ID, CLIENT_SECRET (secret), ALLOWED_ORIGIN
// (ex. https://monnom.github.io — l'adresse de VOTRE app, sans slash final).

const API_ALLOWED = [/^\/athlete\/activities$/, /^\/athlete\/zones$/, /^\/activities\/\d+\/streams$/];

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) return new Response('forbidden', { status: 403 });

    const url = new URL(request.url);
    const reply = r => new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (url.pathname === '/token' && request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const p = new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET, grant_type: b.grant_type });
      if (b.grant_type === 'authorization_code' && b.code) p.set('code', b.code);
      else if (b.grant_type === 'refresh_token' && b.refresh_token) p.set('refresh_token', b.refresh_token);
      else return new Response('bad request', { status: 400, headers: cors });
      return reply(await fetch('https://www.strava.com/oauth/token', { method: 'POST', body: p }));
    }
    if (url.pathname.startsWith('/api/') && request.method === 'GET') {
      const path = url.pathname.slice(4);
      if (!API_ALLOWED.some(re => re.test(path))) return new Response('not allowed', { status: 403, headers: cors });
      return reply(await fetch('https://www.strava.com/api/v3' + path + url.search, {
        headers: { Authorization: request.headers.get('Authorization') || '' },
      }));
    }
    return new Response('not found', { status: 404, headers: cors });
  },
};
