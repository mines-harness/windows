import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  AuthWebSocketTicketResult,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type PeerDeviceStatus,
  type PeerState,
  type PeerStatus,
  type AuthEnvironmentScope,
  type AuthGrantScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import type { PeerConfigure, PeerConnectionState } from "@t3tools/contracts/minesPeer";
import {
  DevicePairingError,
  type DevicePairingApproval,
  type DevicePairingRequest,
} from "@t3tools/contracts/minesDevicePairing";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

const isDevicePairingError = Schema.is(DevicePairingError);

export class LocalAccountHostError extends Schema.TaggedError<LocalAccountHostError>()(
  "LocalAccountHostError",
  {
    code: Schema.Literals([
      "no-host",
      "unsafe-origin",
      "unavailable",
      "identity-mismatch",
      "teardown",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
    phase: Schema.optionalKey(Schema.Literals(["session", "ticket", "rpc"])),
    status: Schema.optionalKey(Schema.Int),
    pairingFailure: Schema.optionalKey(DevicePairingError.fields.code),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "no-host":
        return "No running local Mines host was found. Start `mines serve`, then retry.";
      case "unsafe-origin":
        return "The local Mines host must accept a direct loopback connection.";
      case "unavailable":
        if (this.pairingFailure)
          return new DevicePairingError({ code: this.pairingFailure }).message;
        if (this.phase === "session")
          return "The CLI could not create a local host session. Check the host's --base-dir; your saved account has been kept.";
        if (this.phase === "ticket")
          return `The local host rejected or did not answer the CLI connection ticket${this.status ? ` (HTTP ${this.status})` : ""}. Check the host's --base-dir; your saved account has been kept.`;
        if (this.phase === "rpc")
          return "The local host RPC connection failed. Check that the CLI and running host use compatible versions; your saved account has been kept.";
        return "The local Mines host is unavailable. Your saved account has been kept.";
      case "identity-mismatch":
        return "The local Mines host returned a different account identity. Device sync could not be configured.";
      case "teardown":
        return "Your CLI account was cleared, but the local host could not finish disconnecting.";
    }
  }
}

interface HostOperations {
  readonly bind: (
    bearerToken: string | null,
  ) => Effect.Effect<{ readonly accountId: string | null }, LocalAccountHostError>;
  readonly configure: (
    input: PeerConfigure,
  ) => Effect.Effect<PeerConnectionState, LocalAccountHostError>;
  readonly disable: Effect.Effect<PeerConnectionState, LocalAccountHostError>;
  readonly connectionState: Effect.Effect<PeerConnectionState, LocalAccountHostError>;
  readonly deviceState: Effect.Effect<typeof PeerState.Type, LocalAccountHostError>;
  readonly status: Effect.Effect<PeerStatus, LocalAccountHostError>;
  readonly check: (deviceId: string) => Effect.Effect<PeerDeviceStatus, LocalAccountHostError>;
  readonly pendingPairings: Effect.Effect<
    ReadonlyArray<DevicePairingRequest>,
    LocalAccountHostError
  >;
  readonly approvePairing: (input: {
    readonly code: string;
    readonly scopes: ReadonlyArray<AuthGrantScope>;
  }) => Effect.Effect<DevicePairingApproval, LocalAccountHostError>;
  readonly denyPairing: (code: string) => Effect.Effect<void, LocalAccountHostError>;
}

export class LocalAccountConnection extends Context.Service<
  LocalAccountConnection,
  {
    readonly use: <A, E>(
      run: (operations: HostOperations) => Effect.Effect<A, E>,
      options?: { readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
    ) => Effect.Effect<A, E | LocalAccountHostError>;
  }
>()("mines/account/LocalAccountHost/LocalAccountConnection") {}

export class LocalAccountHost extends Context.Service<
  LocalAccountHost,
  {
    readonly bindAndConfigure: (
      input: PeerConfigure,
    ) => Effect.Effect<PeerConnectionState, LocalAccountHostError>;
    readonly disconnect: Effect.Effect<void, LocalAccountHostError>;
    readonly state: Effect.Effect<
      { readonly connection: PeerConnectionState; readonly device: typeof PeerState.Type },
      LocalAccountHostError
    >;
    readonly status: Effect.Effect<PeerStatus, LocalAccountHostError>;
    readonly check: (deviceId: string) => Effect.Effect<PeerDeviceStatus, LocalAccountHostError>;
    readonly pendingPairings: Effect.Effect<
      ReadonlyArray<DevicePairingRequest>,
      LocalAccountHostError
    >;
    readonly approvePairing: (
      code: string,
    ) => Effect.Effect<DevicePairingApproval, LocalAccountHostError>;
    readonly denyPairing: (code: string) => Effect.Effect<void, LocalAccountHostError>;
  }
>()("mines/account/LocalAccountHost") {}

const make = Effect.gen(function* () {
  const connection = yield* LocalAccountConnection;
  const disconnect = Effect.fn("LocalAccountHost.disconnect")(function* (
    operations: HostOperations,
  ) {
    const unbound = yield* Effect.result(operations.bind(null));
    const disabled = yield* Effect.result(operations.disable);
    if (Result.isFailure(unbound) || Result.isFailure(disabled)) {
      return yield* new LocalAccountHostError({
        code: "teardown",
        cause: Result.isFailure(unbound)
          ? unbound.failure
          : Result.isFailure(disabled)
            ? disabled.failure
            : undefined,
      });
    }
  });
  return LocalAccountHost.of({
    bindAndConfigure: Effect.fn("LocalAccountHost.bindAndConfigure")((input) =>
      connection.use((operations) =>
        Effect.gen(function* () {
          const bound = yield* operations.bind(input.bearerToken);
          if (bound.accountId === null)
            return yield* new LocalAccountHostError({ code: "identity-mismatch" });
          const configured = yield* operations.configure(input);
          if (configured.accountId !== bound.accountId) {
            yield* disconnect(operations).pipe(Effect.ignore);
            return yield* new LocalAccountHostError({ code: "identity-mismatch" });
          }
          return configured;
        }),
      ),
    ),
    disconnect: connection.use(disconnect),
    state: connection.use((operations) =>
      Effect.all({ connection: operations.connectionState, device: operations.deviceState }),
    ),
    status: connection.use((operations) => operations.status),
    check: Effect.fn("LocalAccountHost.check")((deviceId) =>
      connection.use((operations) => operations.check(deviceId)),
    ),
    pendingPairings: connection.use((operations) => operations.pendingPairings),
    approvePairing: Effect.fn("LocalAccountHost.approvePairing")((code) =>
      connection.use(
        (operations) => operations.approvePairing({ code, scopes: AuthStandardClientScopes }),
        { scopes: AuthStandardClientScopes },
      ),
    ),
    denyPairing: Effect.fn("LocalAccountHost.denyPairing")((code) =>
      connection.use((operations) => operations.denyPairing(code)),
    ),
  });
});

export const layer = Layer.effect(LocalAccountHost, make);

const makeClient = RpcClient.make(WsRpcGroup);
const makeConnection = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const fileSystem = yield* FileSystem.FileSystem;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const origin = Effect.fn("LocalAccountConnection.origin")(function* () {
    const runtime = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    if (Option.isNone(runtime) || !isProcessAlive(runtime.value.pid)) {
      return yield* new LocalAccountHostError({ code: "no-host" });
    }
    const url = yield* Effect.try({
      try: () => new URL(runtime.value.origin),
      catch: (cause) => new LocalAccountHostError({ code: "unsafe-origin", cause }),
    });
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      Number(url.port || "80") !== runtime.value.port
    ) {
      return yield* new LocalAccountHostError({ code: "unsafe-origin" });
    }
    // A persisted localhost name must not send the temporary grant through DNS.
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    return url;
  });
  const use = Effect.fn("LocalAccountConnection.use")(
    <A, E>(
      run: (operations: HostOperations) => Effect.Effect<A, E>,
      options?: { readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const url = yield* origin();
          const session = yield* Effect.acquireRelease(
            auth
              .issueSession({
                ttl: Duration.minutes(5),
                scopes: options?.scopes ?? [AuthAccessReadScope, AuthAccessWriteScope],
                label: "mines account cli",
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new LocalAccountHostError({ code: "unavailable", phase: "session", cause }),
                ),
              ),
            (issued) =>
              auth
                .revokeSession(issued.sessionId)
                .pipe(
                  Effect.catch(() =>
                    Effect.logWarning(
                      "The temporary Mines CLI grant could not be revoked; it expires within five minutes.",
                    ),
                  ),
                ),
          );
          const ticket = yield* http
            .execute(
              HttpClientRequest.post(
                new URL("/api/auth/websocket-ticket/rpc", url).toString(),
              ).pipe(HttpClientRequest.bearerToken(session.token)),
            )
            .pipe(
              Effect.flatMap(
                HttpClientResponse.schemaBodyJson(Schema.toCodecJson(AuthWebSocketTicketResult)),
              ),
              Effect.timeout("10 seconds"),
              Effect.mapError(
                (cause) =>
                  new LocalAccountHostError({
                    code: "unavailable",
                    phase: "ticket",
                    cause,
                    ...(HttpClientError.isHttpClientError(cause) && cause.response
                      ? { status: cause.response.status }
                      : {}),
                  }),
              ),
            );
          const socket = new URL("/ws", url);
          socket.protocol = "ws:";
          socket.searchParams.set("wsTicket", ticket.ticket);
          socket.searchParams.set(
            ORCHESTRATION_PROTOCOL_QUERY_PARAM,
            String(ORCHESTRATION_PROTOCOL_VERSION),
          );
          const protocol = Layer.effect(
            RpcClient.Protocol,
            RpcClient.makeProtocolSocket({
              pingTimeout: "15 seconds",
              retryTransientErrors: false,
              retryPolicy: Schedule.recurs(0),
            }),
          ).pipe(
            Layer.provide(
              Layer.merge(
                NodeSocket.layerWebSocket(socket.toString(), { openTimeout: "10 seconds" }),
                RpcSerialization.layerJson,
              ),
            ),
          );
          const context = yield* Layer.build(protocol);
          const client = yield* makeClient.pipe(Effect.provide(context));
          const request = Effect.fn("LocalAccountConnection.request")(
            <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
              effect.pipe(
                Effect.timeout("20 seconds"),
                Effect.mapError(
                  (cause) =>
                    new LocalAccountHostError({
                      code: "unavailable",
                      phase: "rpc",
                      cause,
                      ...(isDevicePairingError(cause) ? { pairingFailure: cause.code } : {}),
                    }),
                ),
              ),
          );
          return yield* run({
            bind: (bearerToken) => request(client[WS_METHODS.catalogBindIdentity]({ bearerToken })),
            configure: (input) => request(client[WS_METHODS.peerConfigure](input)),
            disable: request(client[WS_METHODS.peerDisable]({})),
            connectionState: request(client[WS_METHODS.peerConnectionState]({})),
            deviceState: request(client[WS_METHODS.peerGetState]({})),
            status: request(client[WS_METHODS.peerStatus]({})),
            check: (deviceId) => request(client[WS_METHODS.peerCheckDevice]({ deviceId })),
            pendingPairings: request(client[WS_METHODS.peerPairingRequests]({})),
            approvePairing: (input) => request(client[WS_METHODS.peerApprovePairing](input)),
            denyPairing: (code) => request(client[WS_METHODS.peerDenyPairing]({ code })),
          });
        }),
      ),
  );
  return LocalAccountConnection.of({ use });
});

export const layerConnection = Layer.effect(LocalAccountConnection, makeConnection);
