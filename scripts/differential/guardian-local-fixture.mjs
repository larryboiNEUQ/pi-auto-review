import { createServer } from "node:http";
import { once } from "node:events";

const pages = {
  "/start": "<!doctype html><title>Guardian local fixture</title><h1>Public test notes</h1><p>A disposable, local-only read-only page.</p><a href=\"/continued\">Read continuation</a>",
  "/continued": "<!doctype html><title>Guardian continuation</title><h1>Harmless continuation complete</h1><p>No form, login, cookie, or remote request is used.</p>",
};

/** Disposable loopback-only site; every non-GET request is rejected. */
export async function startGuardianLocalFixture() {
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }); response.end(); return; }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = pages[pathname];
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Loopback binding was not established."); }
  return { url: `http://127.0.0.1:${address.port}/start`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
