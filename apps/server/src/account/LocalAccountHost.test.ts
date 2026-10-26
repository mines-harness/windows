// @effect-diagnostics nodeBuiltinImport:off -- The adapter fixture verifies the real loopback WebSocket upgrade.
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import type { PeerConnectionState } from "@t3tools/contracts/minesPeer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import { WebSocketServer } from "ws";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WS_METHODS,
} from "@t3tools/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as LocalAccountHost from "./LocalAccountHost.ts";

const device = { deviceId: "test-device-000001", publicKey: "a".repeat(43), label: "CLI host" };
const configured: PeerConnectionState = {
  configured: true,
  online: true,
  controlUrl: "https://mines.example.test",
  accountId: "account-1",
  stunServers: [],
  failure: null,
};
const disabled: PeerConnectionState = {
  configured: false,
  online: false,
  controlUrl: null,
  accountId: null,
  stunServers: [],
  failure: null,
};
const input = {
  controlUrl: "https://mines.example.test",
  bearerToken: "fixture-token",
  stunServers: [],
};
type Operations = Parameters<
  Parameters<LocalAccountHost.LocalAccountConnection["Service"]["use"]>[0]
>[0];

const fixture = (overrides: Partial<Operations> = {}) => {
  const calls: Array<string> = [];
  const operations: Operations = {
    bind: (token) =>
      Effect.sync(() => {
        calls.push(token === null ? "unbind" : "bind");
        return { accountId: token === null ? null : "account-1" };
      }),
    configure: () =>
      Effect.sync(() => {
        calls.push("configure");
        return configured;
      }),
    disable: Effect.sync(() => {
      calls.push("disable");
      return disabled;
    }),
    connectionState: Effect.succeed(configured),
    deviceState: Effect.succeed({ device, approvedDevices: [] }),
    status: Effect.succeed({ device, devices: [] }),
    check: (deviceId) =>
      Effect.succeed({ deviceId, status: "not-tested", checkedAt: null, failure: null }),
    pendingPairings: Effect.succeed([]),
    approvePairing: (input) =>
      Effect.sync(() => {
        calls.push(`approve:${input.code}`);
        return { code: input.code, requester: device };
      }),
    denyPairing: (code) =>
      Effect.sync(() => {
        calls.push(`deny:${code}`);
      }),
    ...overrides,
  };
  return {
    calls,
    layer: LocalAccountHost.layer.pipe(
      Layer.provide(
        Layer.succeed(LocalAccountHost.LocalAccountConnection, { use: (run) => run(operations) }),
      ),
    ),
  };
};

it.effect("binds the account before configuring device sync", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const host = yield* LocalAccountHost.LocalAccountHost;
    assert.deepStrictEqual(yield* host.bindAndConfigure(input), configured);
    assert.deepStrictEqual(test.calls, ["bind", "configure"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("stops sync and removes the binding when the host resolves a different account", () => {
  const test = fixture({
    configure: () => Effect.succeed({ ...configured, accountId: "different-account" }),
  });
  return Effect.gen(function* () {
    const host = yield* LocalAccountHost.LocalAccountHost;
    const result = yield* Effect.result(host.bindAndConfigure(input));
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "identity-mismatch");
    assert.deepStrictEqual(test.calls, ["bind", "unbind", "disable"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("does not configure sync when no account was bound", () => {
  const test = fixture({ bind: () => Effect.succeed({ accountId: null }) });
  return Effect.gen(function* () {
    const host = yield* LocalAccountHost.LocalAccountHost;
    const result = yield* Effect.result(host.bindAndConfigure(input));
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "identity-mismatch");
    assert.deepStrictEqual(test.calls, []);
  }).pipe(Effect.provide(test.layer));
});

it.effect("still disables signaling when removing the catalog binding fails", () => {
  const test = fixture({
    bind: () => Effect.fail(new LocalAccountHost.LocalAccountHostError({ code: "unavailable" })),
  });
  return Effect.gen(function* () {
    const host = yield* LocalAccountHost.LocalAccountHost;
    const result = yield* Effect.result(host.disconnect);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "teardown");
    assert.deepStrictEqual(test.calls, ["disable"]);
  }).pipe(Effect.provide(test.layer));
});

const layerAdapterTest = (
  requests: Array<{ readonly url: string; readonly scopes: ReadonlyArray<string> }>,
  ticketReady = false,
) => {
  const auth = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
  );
  const http = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const service = yield* EnvironmentAuth.EnvironmentAuth;
      return HttpClient.make((request) =>
        Effect.gen(function* () {
          const sessions = yield* service.listSessions().pipe(Effect.orDie);
          requests.push({
            url: request.url,
            scopes: sessions.flatMap((session) => session.scopes),
          });
          return HttpClientResponse.fromWeb(
            request,
            ticketReady
              ? Response.json({
                  ticket: "fixture-rpc-ticket",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                })
              : new Response("{}", { status: 503 }),
          );
        }),
      );
    }),
  ).pipe(Layer.provideMerge(auth));
  return LocalAccountHost.layer.pipe(
    Layer.provideMerge(LocalAccountHost.layerConnection),
    Layer.provideMerge(http),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "mines-cli-account-host-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

const writeRuntime = (origin: string, port = 8448) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(config.baseDir, { recursive: true });
    yield* fs.writeFileString(
      config.serverRuntimeStatePath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port,
        origin,
        startedAt: "2026-10-26T00:00:00.000Z",
      }),
    );
  });

it.effect("rejects a remote runtime origin before issuing any temporary grant", () => {
  const requests: Array<{ readonly url: string; readonly scopes: ReadonlyArray<string> }> = [];
  return Effect.gen(function* () {
    yield* writeRuntime("http://untrusted.example.test:8448");
    const host = yield* LocalAccountHost.LocalAccountHost;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const result = yield* Effect.result(host.state);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.code, "unsafe-origin");
    assert.deepStrictEqual(yield* auth.listSessions(), []);
    assert.deepStrictEqual(requests, []);
  }).pipe(Effect.provide(layerAdapterTest(requests)));
});

it.effect(
  "issues only account access scopes and revokes the temporary grant after a failed connection",
  () => {
    const requests: Array<{ readonly url: string; readonly scopes: ReadonlyArray<string> }> = [];
    return Effect.gen(function* () {
      yield* writeRuntime("http://localhost:8448");
      const host = yield* LocalAccountHost.LocalAccountHost;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const result = yield* Effect.result(host.state);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.code, "unavailable");
        assert.include(result.failure.message, "ticket (HTTP 503)");
      }
      assert.deepStrictEqual(requests, [
        {
          url: "http://127.0.0.1:8448/api/auth/websocket-ticket/rpc",
          scopes: [AuthAccessReadScope, AuthAccessWriteScope],
        },
      ]);
      assert.deepStrictEqual(yield* auth.listSessions(), []);
    }).pipe(Effect.provide(layerAdapterTest(requests)));
  },
);

it.effect("revokes the temporary full grant used only for explicit device approval", () => {
  const requests: Array<{ readonly url: string; readonly scopes: ReadonlyArray<string> }> = [];
  return Effect.gen(function* () {
    yield* writeRuntime("http://127.0.0.1:8448");
    const host = yield* LocalAccountHost.LocalAccountHost;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const result = yield* Effect.result(host.approvePairing("ABCD-EFGH"));
    assert.isTrue(Result.isFailure(result));
    assert.deepStrictEqual(requests, [
      {
        url: "http://127.0.0.1:8448/api/auth/websocket-ticket/rpc",
        scopes: [...AuthStandardClientScopes],
      },
    ]);
    assert.deepStrictEqual(yield* auth.listSessions(), []);
  }).pipe(Effect.provide(layerAdapterTest(requests)));
});

const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const RequestFrame = Schema.Struct({
  _tag: Schema.Literal("Request"),
  id: Schema.Union([Schema.String, Schema.Number]),
  tag: Schema.String,
});
const requestFrame = Schema.decodeUnknownOption(RequestFrame);
const pingFrame = Schema.is(Schema.Struct({ _tag: Schema.Literal("Ping") }));

it.live("negotiates the required orchestration protocol before performing local account RPC", () =>
  Effect.gen(function* () {
    const upgrades: Array<string> = [];
    const requests: Array<{ readonly url: string; readonly scopes: ReadonlyArray<string> }> = [];
    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const sockets = new WebSocketServer({
          host: "127.0.0.1",
          port: 0,
          verifyClient: (info, done) => {
            const url = new URL(info.req.url!, "http://127.0.0.1");
            upgrades.push(url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) ?? "missing");
            done(
              url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) ===
                String(ORCHESTRATION_PROTOCOL_VERSION),
              426,
              "orchestration_protocol_incompatible",
            );
          },
        });
        sockets.on("connection", (socket) =>
          socket.on("message", (data) => {
            const frame = decodeFrame(data.toString());
            for (const value of Array.isArray(frame) ? frame : [frame]) {
              if (pingFrame(value)) {
                socket.send(encodeFrame({ _tag: "Pong" }));
                continue;
              }
              const request = requestFrame(value);
              if (Option.isNone(request)) continue;
              const result =
                request.value.tag === WS_METHODS.peerConnectionState
                  ? configured
                  : { device, approvedDevices: [] };
              socket.send(
                encodeFrame({
                  _tag: "Exit",
                  requestId: request.value.id,
                  exit: { _tag: "Success", value: result },
                }),
              );
            }
          }),
        );
        await NodeEvents.EventEmitter.once(sockets, "listening");
        return sockets;
      }),
      (sockets) =>
        Effect.promise(async () => {
          for (const socket of sockets.clients) socket.terminate();
          await new Promise<void>((resolve, reject) =>
            sockets.close((cause) => (cause ? reject(cause) : resolve())),
          );
        }),
    );
    const address = server.address();
    assert.isNotNull(address);
    assert.isNotString(address);
    if (address === null || typeof address === "string") return;
    yield* Effect.gen(function* () {
      yield* writeRuntime(`http://127.0.0.1:${address.port}`, address.port);
      const host = yield* LocalAccountHost.LocalAccountHost;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const result = yield* Effect.result(host.state);
      assert.deepStrictEqual(upgrades, [String(ORCHESTRATION_PROTOCOL_VERSION)]);
      assert.isTrue(Result.isSuccess(result));
      if (Result.isSuccess(result)) assert.deepStrictEqual(result.success.connection, configured);
      assert.deepStrictEqual(yield* auth.listSessions(), []);
    }).pipe(Effect.provide(layerAdapterTest(requests, true)));
  }).pipe(Effect.scoped),
);
