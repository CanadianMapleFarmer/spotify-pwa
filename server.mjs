import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 5173);
const pairedSpotifySessions = new Map();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
};

createServer((request, response) => {
  const address = request.socket.remoteAddress;
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "POST" && url.pathname === "/__probe-log") {
    readJson(request, 64 * 1024)
      .then((parsed) => {
        console.log(`[probe] ${address} ${parsed.level || "info"} ${parsed.message || ""}`);
        response.writeHead(204, corsHeaders());
        response.end();
      })
      .catch((error) => {
        console.log(`[probe] ${address} invalid log payload: ${error.message}`);
        response.writeHead(204, corsHeaders());
        response.end();
      });
    return;
  }

  if (url.pathname === "/__spotify-session") {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }
    handleSpotifySession(request, response, url, address);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, corsHeaders());
    response.end();
    return;
  }

  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(root, requestPath));

  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    console.log(`[http] ${address} 404 ${request.method} ${url.pathname}${url.search}`);
    response.writeHead(404, { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const type = contentTypes[extname(filePath)] || "application/octet-stream";
  console.log(`[http] ${address} 200 ${request.method} ${url.pathname}${url.search}`);
  response.writeHead(200, {
    ...corsHeaders(),
    "Content-Type": type,
    "Cache-Control": "no-store, max-age=0",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}).listen(port, "::", () => {
  console.log(`Spotify VIDAA probe server listening on http://0.0.0.0:${port}/`);
});

async function handleSpotifySession(request, response, url, address) {
  if (request.method === "GET") {
    const pairCode = normalizePairCode(url.searchParams.get("pairCode"));
    if (!pairCode) {
      sendJson(response, 400, { error: "missing_pair_code" });
      return;
    }

    const session = pairedSpotifySessions.get(pairCode);
    if (!session) {
      sendJson(response, 404, { error: "not_ready" });
      return;
    }

    if (session.expiresAt <= Date.now()) {
      pairedSpotifySessions.delete(pairCode);
      sendJson(response, 410, { error: "expired" });
      return;
    }

    console.log(`[pair] ${address} token fetched for ${pairCode}`);
    sendJson(response, 200, session);
    return;
  }

  if (request.method === "POST") {
    try {
      const payload = await readJson(request, 128 * 1024);
      const pairCode = normalizePairCode(payload.pairCode);
      if (!pairCode || !payload.accessToken || !payload.expiresAt) {
        sendJson(response, 400, { error: "invalid_payload" });
        return;
      }

      const session = {
        accessToken: String(payload.accessToken),
        refreshToken: payload.refreshToken ? String(payload.refreshToken) : "",
        expiresAt: Number(payload.expiresAt),
        receivedAt: Date.now(),
      };
      pairedSpotifySessions.set(pairCode, session);
      console.log(`[pair] ${address} token stored for ${pairCode}`);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  response.writeHead(405, corsHeaders());
  response.end();
}

function normalizePairCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("payload_too_large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
  });
  response.end(JSON.stringify(payload));
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
