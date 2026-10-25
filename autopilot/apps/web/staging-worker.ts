/**
 * TEST deployment only (wrangler env "staging"): same-origin proxy so the browser talks to one Access-protected host.
 * /v1/* is forwarded unchanged (including Cf-Access-Jwt-Assertion) to the API over a service binding; the API still
 * verifies the Access JWT itself. Everything else is served from static assets.
 */
interface Fetcher {
  fetch(req: Request): Promise<Response>;
}
export default {
  fetch(req: Request, env: { API: Fetcher; ASSETS: Fetcher }): Promise<Response> {
    return new URL(req.url).pathname.startsWith("/v1/") ? env.API.fetch(req) : env.ASSETS.fetch(req);
  },
};
