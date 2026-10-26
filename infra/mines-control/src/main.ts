// @effect-diagnostics-next-line nodeBuiltinImport:off -- ws upgrades need the native HTTP server boundary.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import { PeerSignal } from "@t3tools/contracts/minesPeer";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import { WebSocketServer } from "ws";

import * as DeviceDirectory from "./DeviceDirectory.ts";
import * as DevicePairing from "./DevicePairing.ts";
import { handleDevicePairingRequest } from "./DevicePairingRoutes.ts";
import * as Signaling from "./Signaling.ts";
import * as Push from "./Push.ts";
import * as PushStore from "./PushStore.ts";
import { parseAllowedOrigins } from "./allowedOrigins.ts";
import * as AccountAuth from "./AccountAuth.ts";
import * as Contacts from "./Contacts.ts";
import * as ContactsStore from "./ContactsStore.ts";
import { handleContactsRequest, isContactsPath } from "./ContactsRoutes.ts";
import { handleContactsAvatarRequest, isContactsAvatarPath } from "./ContactsAvatarRoutes.ts";
import { accountAssets } from "./accountPage.ts";
import { makeSocketHeartbeat } from "./SocketHeartbeat.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

const decodeSignal = Schema.decodeUnknownSync(PeerSignal);

const origins = parseAllowedOrigins(required("MINES_ALLOWED_ORIGINS"));
const authURL = required("MINES_AUTH_URL");
const smtpPort = Number(process.env.MINES_SMTP_PORT ?? 25);
if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535)
  throw new Error("Invalid MINES_SMTP_PORT.");
const database = PgClient.layer({
  url: Redacted.make(required("DATABASE_URL")),
  maxConnections: 4,
});
const directory = DeviceDirectory.layer.pipe(Layer.provide(database));
const contactStore = ContactsStore.layer(authURL).pipe(Layer.provide(database));
const contacts = Contacts.layer.pipe(Layer.provide(Layer.merge(directory, contactStore)));
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    Signaling.layer,
    DevicePairing.layer,
    Push.layer,
    AccountAuth.layer({
      databaseURL: required("DATABASE_URL"),
      baseURL: authURL,
      secret: required("MINES_AUTH_SECRET"),
      origins,
      smtp: process.env.MINES_SMTP_HOST
        ? {
            host: process.env.MINES_SMTP_HOST,
            port: smtpPort,
            from: required("MINES_SMTP_FROM"),
            user: process.env.MINES_SMTP_USER,
            password: process.env.MINES_SMTP_PASSWORD,
          }
        : undefined,
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        directory,
        contactStore,
        contacts,
        PushStore.layer.pipe(Layer.provide(database)),
        Layer.succeed(
          Push.PushDelivery,
          Push.expoDelivery(process.env.MINES_EXPO_PUSH_ACCESS_TOKEN),
        ),
      ),
    ),
    Layer.provide(NodeServices.layer),
  ),
);
await runtime.runPromise(
  Effect.flatMap(DeviceDirectory.DeviceDirectory, (service) => service.initialize).pipe(
    Effect.andThen(Effect.flatMap(PushStore.PushStore, (service) => service.initialize)),
    Effect.andThen(Effect.flatMap(AccountAuth.AccountAuth, (service) => service.initialize)),
    Effect.andThen(Effect.flatMap(ContactsStore.ContactsStore, (service) => service.initialize)),
  ),
);

async function accountId(request: NodeHttp.IncomingMessage): Promise<string> {
  return runtime.runPromise(
    Effect.flatMap(AccountAuth.AccountAuth, (service) =>
      service.accountId(new Headers({ authorization: request.headers.authorization ?? "" })),
    ),
  );
}

function allowedOrigin(request: NodeHttp.IncomingMessage): boolean {
  return request.headers.origin === undefined || origins.includes(request.headers.origin);
}

async function readRequestBody(
  request: NodeHttp.IncomingMessage,
  maximumBytes = 8_192,
): Promise<string> {
  let size = 0;
  const chunks: Array<Buffer> = [];
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    size += chunk.length;
    if (size > maximumBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const readBody = async (request: NodeHttp.IncomingMessage): Promise<unknown> =>
  JSON.parse(await readRequestBody(request));

function json(response: NodeHttp.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const handle = async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
  if (!allowedOrigin(request)) {
    json(response, 403, { error: "origin_rejected" });
    return;
  }
  const origin = request.headers.origin;
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-headers", "authorization,content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    response.setHeader("access-control-expose-headers", "set-auth-token");
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz" && request.method === "GET") {
    json(response, 200, { ok: true });
    return;
  }
  const asset = accountAssets.get(url.pathname);
  if (asset && request.method === "GET") {
    response.writeHead(200, {
      "content-type": asset.type,
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(asset.body);
    return;
  }
  if (url.pathname === "/v1/auth-config" && request.method === "GET") {
    const configuration = await runtime.runPromise(
      Effect.map(AccountAuth.AccountAuth, (service) => service.configuration),
    );
    json(response, 200, configuration);
    return;
  }
  if (url.pathname.startsWith("/api/auth/")) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (value) for (const item of value) headers.append(name, item);
    }
    const method = request.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
    const authResponse = await runtime.runPromise(
      Effect.flatMap(AccountAuth.AccountAuth, (service) =>
        service.handle(
          new Request(new URL(request.url ?? "/", authURL), {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
          }),
        ),
      ),
    );
    authResponse.headers.forEach((value, name) => {
      if (name !== "set-cookie") response.setHeader(name, value);
    });
    const cookies = authResponse.headers.getSetCookie();
    if (cookies.length) response.setHeader("set-cookie", cookies);
    response.setHeader("cache-control", "no-store");
    response.writeHead(authResponse.status);
    response.end(Buffer.from(await authResponse.arrayBuffer()));
    return;
  }
  if (url.pathname === "/v1/device-tickets" && request.method === "POST") {
    const proof = await readBody(request);
    const ticket = await runtime.runPromise(
      Effect.flatMap(Signaling.Signaling, (service) => service.deviceTicket(proof)),
    );
    json(response, 200, { ticket });
    return;
  }
  if (url.pathname === "/v1/device-pairings") {
    const body = request.method === "POST" ? await readRequestBody(request, 96 * 1024) : "";
    const result = await runtime.runPromise(
      handleDevicePairingRequest({
        method: request.method ?? "GET",
        body: body ? JSON.parse(body) : undefined,
      }),
    );
    json(response, result.status, result.value);
    return;
  }
  if (
    (url.pathname === "/v1/push/alerts" || url.pathname === "/v1/push/device") &&
    request.method === "POST"
  ) {
    const body = await readBody(request);
    const account = request.headers.authorization ? await accountId(request) : undefined;
    const result = await runtime.runPromise(
      Effect.flatMap(Push.Push, (service) => service.execute(body, account)).pipe(
        Effect.map((value) => ({ status: 200, value })),
        Effect.catch((error) =>
          Effect.succeed({
            status: error.code === "disabled" ? 503 : error.code === "rate-limited" ? 429 : 403,
            value: { error: error.code },
          }),
        ),
      ),
    );
    json(response, result.status, result.value);
    return;
  }
  if (isContactsAvatarPath(url.pathname)) {
    const result = await runtime.runPromise(
      handleContactsAvatarRequest({ pathname: url.pathname, method: request.method ?? "GET" }),
    );
    response.writeHead(result.status, result.headers);
    response.end(result.body);
    return;
  }
  if (isContactsPath(url.pathname)) {
    const text =
      request.method === "POST"
        ? await readRequestBody(
            request,
            url.pathname === "/v1/contacts/profile" ? 24 * 1024 : 8_192,
          )
        : "";
    const result = await runtime.runPromise(
      handleContactsRequest({
        pathname: url.pathname,
        method: request.method ?? "GET",
        headers: new Headers({ authorization: request.headers.authorization ?? "" }),
        body: text ? JSON.parse(text) : undefined,
      }),
    );
    json(response, result.status, result.value);
    return;
  }
  let account: string;
  try {
    account = await accountId(request);
  } catch {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  if (url.pathname === "/v1/account" && request.method === "GET") {
    json(response, 200, { accountId: account });
  } else if (url.pathname === "/v1/push/capability" && request.method === "GET") {
    const enabled = await runtime.runPromise(Effect.map(Push.Push, (service) => service.enabled));
    json(response, 200, { enabled, transport: enabled ? "expo" : null });
  } else if (url.pathname === "/v1/devices" && request.method === "GET") {
    const devices = await runtime.runPromise(
      Effect.flatMap(Signaling.Signaling, (service) => service.devices(account)),
    );
    json(response, 200, devices);
  } else if (url.pathname === "/v1/devices" && request.method === "POST") {
    const proof = await readBody(request);
    await runtime.runPromise(
      Effect.flatMap(Signaling.Signaling, (service) => service.register(account, proof)),
    );
    json(response, 200, { ok: true, accountId: account });
  } else if (url.pathname === "/v1/tickets" && request.method === "POST") {
    const proof = await readBody(request);
    const ticket = await runtime.runPromise(
      Effect.flatMap(Signaling.Signaling, (service) => service.ticket(account, proof)),
    );
    json(response, 200, { ticket });
  } else if (url.pathname.startsWith("/v1/devices/") && request.method === "DELETE") {
    const deviceId = url.pathname.slice("/v1/devices/".length);
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(deviceId)) {
      json(response, 400, { error: "invalid_device" });
      return;
    }
    await runtime.runPromise(
      Effect.flatMap(Signaling.Signaling, (service) => service.revoke(account, deviceId)),
    );
    await runtime.runPromise(
      Effect.flatMap(PushStore.PushStore, (service) => service.remove(account, deviceId)),
    );
    json(response, 200, { ok: true });
  } else json(response, 404, { error: "not_found" });
};

const server = NodeHttp.createServer((request, response) => {
  void handle(request, response).catch(() => json(response, 400, { error: "request_rejected" }));
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.maxHeadersCount = 32;
const sockets = new WebSocketServer({
  noServer: true,
  maxPayload: 96 * 1024,
  perMessageDeflate: false,
});
const heartbeat = makeSocketHeartbeat();
const heartbeatFiber = runtime.runFork(
  Effect.sync(() => heartbeat.pulse()).pipe(Effect.repeat(Schedule.spaced("30 seconds"))),
);
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const ticket = url.searchParams.get("ticket");
  if (!allowedOrigin(request) || url.pathname !== "/v1/signals" || !ticket || ticket.length > 128) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  sockets.handleUpgrade(request, socket, head, (websocket) => {
    websocket.once("close", heartbeat.track(websocket));
    websocket.on("pong", () => heartbeat.pong(websocket));
    void runtime
      .runPromise(
        Effect.flatMap(Signaling.Signaling, (service) =>
          service.connect(ticket, {
            send: (signal) => {
              if (websocket.bufferedAmount > 256 * 1024) websocket.close(1008);
              else websocket.send(JSON.stringify(signal));
            },
            close: () => websocket.close(1008),
          }),
        ),
      )
      .then((connection) => {
        if (websocket.readyState !== websocket.OPEN) {
          connection.disconnect();
          return;
        }
        websocket.on("close", connection.disconnect);
        websocket.on("message", (data, binary) => {
          if (binary) {
            websocket.close(1008);
            return;
          }
          void Promise.resolve()
            .then(() => decodeSignal(JSON.parse(data.toString())))
            .then((signal) =>
              runtime.runPromise(
                Effect.flatMap(Signaling.Signaling, (service) =>
                  service.forward(connection.accountId, connection.device, signal),
                ),
              ),
            )
            .catch(() => websocket.close(1008));
        });
        websocket.send(JSON.stringify({ ready: true }));
      })
      .catch(() => websocket.close(1008));
  });
});

const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid PORT.");
server.listen(port, process.env.HOST ?? "127.0.0.1");
const shutdown = () => {
  void Effect.runPromise(Fiber.interrupt(heartbeatFiber));
  for (const socket of sockets.clients) socket.terminate();
  server.close(() => {
    void runtime.dispose();
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
