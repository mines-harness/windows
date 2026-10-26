import type {
  AuthClientPresentationMetadata,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import {
  appendClientConnectionParams,
  type ClientOwnerParams,
  readClientOwnerParams,
  resolveRemoteWebSocketConnectionUrl,
} from "../authorization/remote.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapRemoteEnvironmentError,
  profileMissingError,
} from "./errors.ts";
import type {
  BearerConnectionTarget,
  ConnectionTarget,
  PreparedConnection,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
} from "./model.ts";
import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";
import { credentialConnectionId } from "./routes.ts";
import {
  PullRequestRoutingPermissions,
  pullRequestRoutingConnectionKey,
} from "./pullRequestRoutingPermissions.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { peerFetch } from "@t3tools/shared/minesPeerAdapters";
import { PeerConnections } from "../peer/connections.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
    /**
     * Authorizes a socket without the orchestration protocol gate, for hosts
     * too old to connect normally. Only update RPCs may run over it.
     */
    readonly prepareForUpdate: (entry: ConnectionCatalogEntry) => Effect.Effect<
      {
        readonly prepared: PreparedConnection;
        readonly descriptor: ExecutionEnvironmentDescriptor;
      },
      ConnectionAttemptError
    >;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);
const isSshProfile = Schema.is(SshConnectionProfile);

function primarySocketUrl(
  target: PrimaryConnectionTarget,
  clientMetadata: AuthClientPresentationMetadata | undefined,
  owners: ClientOwnerParams,
): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  appendClientConnectionParams(url, clientMetadata, "direct", owners);
  return url.toString();
}

const makePrimaryBroker = Effect.fn("clientRuntime.connection.broker.makePrimary")(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.primary")(function* (
    target: PrimaryConnectionTarget,
  ) {
    const isLocal = (address: string) => {
      const url = new URL(address);
      return (
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    };
    if (!isLocal(target.httpBaseUrl) || !isLocal(target.wsBaseUrl)) {
      return yield* new ConnectionBlockedError({
        reason: "unsupported",
        detail: "Remote hosts require an approved direct peer connection.",
      });
    }
    const bearerToken = yield* auth.bearerToken;
    if (Option.isNone(bearerToken)) {
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: primarySocketUrl(target, presentation.metadata, yield* readClientOwnerParams),
        httpAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }

    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      bearerToken: bearerToken.value,
      connectionMethod: "direct",
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* () {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

  return Effect.fn("clientRuntime.connection.broker.bearer")(function* (
    entry: ConnectionCatalogEntry & { readonly target: BearerConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isBearerProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not a bearer connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    if (profile.authorization === "t3-connect" || profile.network === "tailscale") {
      return yield* new ConnectionBlockedError({
        reason: "unsupported",
        detail:
          "Mines uses approved direct peer connections. Set up this device again to remove its legacy relay route.",
      });
    }
    if (!profile.peerDeviceId)
      return yield* new ConnectionBlockedError({
        reason: "unsupported",
        detail:
          "Approve this device and configure a direct peer connection before opening it remotely.",
      });
    const credential = yield* credentials.get(credentialConnectionId(target.connectionId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(credentialMissingError(target.connectionId)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!isBearerCredential(credential)) {
      return yield* credentialMissingError(target.connectionId);
    }
    if (profile.peerDeviceId) {
      const peers = yield* Effect.serviceOption(PeerConnections);
      if (Option.isNone(peers))
        return yield* new ConnectionBlockedError({
          reason: "configuration",
          detail: "Direct device connections are not configured.",
        });
      const peerSession = yield* peers.value
        .connect(profile.peerDeviceId)
        .pipe(
          Effect.mapError((error) =>
            error.code === "unapproved-device"
              ? new ConnectionBlockedError({ reason: "authentication", detail: error.message })
              : new ConnectionTransientError({ reason: "network", detail: error.message }),
          ),
        );
      const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
        httpBaseUrl: profile.httpBaseUrl,
        wsBaseUrl: profile.wsBaseUrl,
        bearerToken: credential.token,
        connectionMethod: "direct",
      }).pipe(
        Effect.provide(layerRemoteHttpClient(peerFetch(peerSession, profile.httpBaseUrl))),
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.onError(() => Effect.sync(peerSession.close)),
      );
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: profile.httpBaseUrl,
        socketUrl,
        httpAuthorization: { _tag: "Bearer" as const, token: credential.token },
        target,
        peerSession,
      } satisfies PreparedConnection;
    }
    return yield* new ConnectionBlockedError({
      reason: "unsupported",
      detail:
        "Approve this device and configure a direct peer connection before opening it remotely.",
    });
  });
});

const makeSshBroker = Effect.fn("clientRuntime.connection.broker.makeSsh")(function* () {
  const profiles = yield* Effect.serviceOption(ConnectionProfileStore.ConnectionProfileStore);
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const ssh = yield* Effect.serviceOption(ClientCapabilities.SshEnvironmentGateway);
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.ssh")(function* (
    entry: ConnectionCatalogEntry & { readonly target: SshConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isSshProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not an SSH connection.`,
      });
    }
    if (profile.connectionId !== target.connectionId) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "The saved SSH profile belongs to a different connection.",
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    if (Option.isNone(ssh)) {
      return yield* new ConnectionBlockedError({
        reason: "unsupported",
        detail: "SSH environments are only available in the desktop app.",
      });
    }
    if (Option.isNone(profiles)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "Saved SSH connections are not configured.",
      });
    }
    const saved = Option.getOrUndefined(yield* credentials.get(target.connectionId));
    const savedToken = saved !== undefined && isBearerCredential(saved) ? saved.token : undefined;
    const prepared = yield* ssh.value.prepare({
      connectionId: target.connectionId,
      expectedEnvironmentId: target.environmentId,
      target: profile.target,
      ...(savedToken === undefined ? {} : { bearerToken: savedToken }),
    });
    if (prepared.bearerToken !== savedToken) {
      yield* credentials.put(
        target.connectionId,
        new BearerConnectionCredential({ token: prepared.bearerToken }),
      );
    }
    const preparedProfile = new SshConnectionProfile({
      connectionId: profile.connectionId,
      environmentId: profile.environmentId,
      label: profile.label,
      target: prepared.bootstrap.target,
    });
    if (
      pullRequestRoutingConnectionKey(entry) !==
      pullRequestRoutingConnectionKey({ ...entry, profile: Option.some(preparedProfile) })
    ) {
      const permissions = yield* PullRequestRoutingPermissions;
      yield* permissions.forget(target.environmentId);
    }
    yield* profiles.value.put(preparedProfile);
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: prepared.bootstrap.httpBaseUrl,
      wsBaseUrl: prepared.bootstrap.wsBaseUrl,
      bearerToken: prepared.bearerToken,
      connectionMethod: "ssh",
    });
    return { ...authorized, target } satisfies PreparedConnection;
  });
});

/** @public */
export const make = Effect.gen(function* () {
  const primary = yield* makePrimaryBroker();
  const bearer = yield* makeBearerBroker();
  const ssh = yield* makeSshBroker();
  const httpClient = yield* HttpClient.HttpClient;

  const authorize = Effect.fn("clientRuntime.connection.broker.authorize")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target: ConnectionTarget = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    const prepared: PreparedConnection = yield* (() => {
      switch (target._tag) {
        case "PrimaryConnectionTarget":
          return primary(target);
        case "BearerConnectionTarget":
          return bearer({ ...entry, target });
        case "RelayConnectionTarget":
          return Effect.fail(
            new ConnectionBlockedError({
              reason: "unsupported",
              detail: "Relay connections are disabled. Connect an approved device directly.",
            }),
          );
        case "SshConnectionTarget":
          return ssh({ ...entry, target });
      }
    })();
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: prepared.httpBaseUrl,
    }).pipe(
      Effect.mapError(mapRemoteEnvironmentError),
      prepared.peerSession
        ? Effect.provide(
            layerRemoteHttpClient(peerFetch(prepared.peerSession, prepared.httpBaseUrl)),
          )
        : Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.onError(() => Effect.sync(() => prepared.peerSession?.close())),
    );
    if (descriptor.environmentId !== target.environmentId) {
      prepared.peerSession?.close();
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    }
    return { prepared, descriptor };
  });

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const { prepared, descriptor } = yield* authorize(entry);
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null) {
      prepared.peerSession?.close();
      return yield* compatibilityError;
    }
    return {
      ...prepared,
      socketUrl: appendOrchestrationProtocol(prepared.socketUrl),
    };
  });

  return ConnectionResolver.of({ prepare, prepareForUpdate: authorize });
});

export const layer = Layer.effect(ConnectionResolver, make);
