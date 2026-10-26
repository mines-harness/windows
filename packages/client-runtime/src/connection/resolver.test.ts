import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  SshConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import * as RpcHttp from "../rpc/http.ts";

const environmentId = EnvironmentId.make("environment-1");
function dependencies(
  calls: string[],
  version: number = ORCHESTRATION_PROTOCOL_VERSION,
  ssh?: {
    readonly credentials: ConnectionCredentialStore.ConnectionCredentialStore["Service"];
    readonly profiles: ConnectionProfileStore.ConnectionProfileStore["Service"];
    readonly gateway: ClientCapabilities.SshEnvironmentGateway["Service"];
    readonly authorize: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  },
) {
  return ConnectionResolver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        RpcHttp.layerRemoteHttpClient(async () => {
          calls.push("http");
          return Response.json({
            environmentId,
            label: "Host",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            orchestrationProtocolVersion: version,
            capabilities: { repositoryIdentity: true },
          });
        }),
        Layer.succeed(
          ConnectionCredentialStore.ConnectionCredentialStore,
          ssh?.credentials ?? {
            get: () => Effect.die("Unexpected legacy credential read"),
            put: () => Effect.void,
            remove: () => Effect.void,
          },
        ),
        ...(ssh === undefined
          ? []
          : [
              Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, ssh.profiles),
              Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh.gateway),
            ]),
        Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
          bearerToken: Effect.succeedNone,
        }),
        Layer.succeed(ClientCapabilities.ClientPresentation, {
          metadata: { label: "Test", deviceType: "desktop", surface: "web" },
        }),
        Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
          authorizeBearer:
            ssh?.authorize ?? (() => Effect.die("Unexpected direct HTTP authorization")),
          authorizeDpop: () => Effect.die("Unexpected relay authorization"),
          authorizeDpopHttp: () => Effect.die("Unexpected relay authorization"),
        }),
      ),
    ),
  );
}
const primary = new PrimaryConnectionTarget({
  environmentId,
  label: "Primary",
  httpBaseUrl: "http://127.0.0.1:3777",
  wsBaseUrl: "ws://127.0.0.1:3777",
});

describe("ConnectionResolver explicit route policy", () => {
  it.effect(
    "keeps local clients without SSH capability usable and rejects only their SSH route",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(dependencies(calls)),
        );
        const local = yield* resolver.prepare({
          target: primary,
          profile: Option.none(),
          enabled: true,
        });
        expect(local.environmentId).toBe(environmentId);
        const target = new SshConnectionTarget({
          environmentId,
          label: "SSH",
          connectionId: "ssh-1",
        });
        const profile = new SshConnectionProfile({
          environmentId,
          label: target.label,
          connectionId: target.connectionId,
          target: { alias: "OVH", hostname: "ovh.example", username: "debian", port: 22 },
        });
        const entry = { target, profile: Option.some(profile), enabled: true };
        expect(yield* Effect.flip(resolver.prepare(entry))).toMatchObject({
          reason: "unsupported",
        });
        expect(calls).toEqual(["http"]);
        const mismatched = new SshConnectionProfile({ ...profile, connectionId: "another-route" });
        expect(
          yield* Effect.flip(resolver.prepare({ ...entry, profile: Option.some(mismatched) })),
        ).toMatchObject({ reason: "configuration" });
        expect(calls).toEqual(["http"]);
      }),
  );

  it.effect("prepares saved SSH routes with their refreshed credential on reconnect", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const target = { alias: "OVH", hostname: "ovh.example", username: "debian", port: 22 };
      const route = new SshConnectionTarget({ environmentId, label: "OVH", connectionId: "ssh-1" });
      const profile = new SshConnectionProfile({
        environmentId,
        connectionId: route.connectionId,
        label: route.label,
        target,
      });
      const entry = { target: route, profile: Option.some(profile), enabled: true };
      let saved = new BearerConnectionCredential({ token: "saved-token" });
      const presentedTokens: Array<string | undefined> = [];
      const profiles: SshConnectionProfile[] = [];
      const ssh = {
        credentials: ConnectionCredentialStore.ConnectionCredentialStore.of({
          get: () => Effect.succeedSome(saved),
          put: (_, credential) =>
            Effect.sync(() => {
              expect(credential._tag).toBe("BearerConnectionCredential");
              if (credential._tag === "BearerConnectionCredential") saved = credential;
            }),
          remove: () => Effect.void,
        }),
        profiles: ConnectionProfileStore.ConnectionProfileStore.of({
          get: () => Effect.succeedSome(profile),
          put: (updated) =>
            Effect.sync(() => {
              if (updated._tag === "SshConnectionProfile") profiles.push(updated);
            }),
          remove: () => Effect.void,
        }),
        gateway: ClientCapabilities.SshEnvironmentGateway.of({
          provision: () => Effect.die("A saved route must not provision another SSH host"),
          prepare: (input) =>
            Effect.sync(() => {
              expect(input.expectedEnvironmentId).toBe(environmentId);
              expect(input.target).toEqual(target);
              presentedTokens.push(input.bearerToken);
              return {
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:41773",
                  wsBaseUrl: "ws://127.0.0.1:41773",
                  pairingToken: null,
                  remotePort: 3773,
                },
                bearerToken: "refreshed-token",
              };
            }),
          disconnect: () => Effect.void,
        }),
        authorize: ((input) =>
          Effect.sync(() => {
            expect(input).toEqual({
              expectedEnvironmentId: environmentId,
              httpBaseUrl: "http://127.0.0.1:41773",
              wsBaseUrl: "ws://127.0.0.1:41773",
              bearerToken: "refreshed-token",
              connectionMethod: "ssh",
            });
            return {
              environmentId,
              label: "OVH",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: `${input.wsBaseUrl}/ws?ticket=ssh-ticket`,
              httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
            };
          })) satisfies RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"],
      };
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(dependencies(calls, ORCHESTRATION_PROTOCOL_VERSION, ssh)),
      );
      const first = yield* resolver.prepare(entry);
      const second = yield* resolver.prepare(entry);
      expect(first.socketUrl).toContain("orchestrationProtocol=2");
      expect(second.httpAuthorization).toEqual({ _tag: "Bearer", token: "refreshed-token" });
      expect(presentedTokens).toEqual(["saved-token", "refreshed-token"]);
      expect(profiles).toEqual([profile, profile]);
      expect(calls).toEqual(["http", "http"]);

      const outdated = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(dependencies([], 1, ssh)),
      );
      expect(yield* Effect.flip(outdated.prepare(entry))).toMatchObject({ reason: "unsupported" });
      const update = yield* outdated.prepareForUpdate(entry);
      expect(update.descriptor.orchestrationProtocolVersion).toBe(1);
      expect(update.prepared.socketUrl).not.toContain("orchestrationProtocol");
    }),
  );
  it.effect("retains local primary connections and the protocol compatibility gate", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(dependencies(calls)),
      );
      const prepared = yield* resolver.prepare({
        target: primary,
        profile: Option.none(),
        enabled: true,
      });
      expect(prepared.socketUrl).toContain("orchestrationProtocol=2");
      expect(prepared.httpAuthorization).toBeNull();
      expect(calls).toEqual(["http"]);
      const old = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(dependencies([], 1)),
      );
      expect(
        yield* Effect.flip(old.prepare({ target: primary, profile: Option.none(), enabled: true })),
      ).toMatchObject({ reason: "unsupported" });
    }),
  );

  const legacy: ReadonlyArray<ConnectionCatalogEntry> = [
    {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Remote primary",
        httpBaseUrl: "https://remote.example",
        wsBaseUrl: "wss://remote.example",
      }),
      profile: Option.none(),
      enabled: true,
    },
    {
      target: new RelayConnectionTarget({ environmentId, label: "Relay" }),
      profile: Option.none(),
      enabled: true,
    },
    ...["plain", "t3-connect", "tailscale"].map((route): ConnectionCatalogEntry => ({
      target: new BearerConnectionTarget({ environmentId, label: route, connectionId: route }),
      profile: Option.some(
        new BearerConnectionProfile({
          environmentId,
          label: route,
          connectionId: route,
          httpBaseUrl: "https://legacy.example",
          wsBaseUrl: "wss://legacy.example",
          ...(route === "t3-connect" ? { authorization: "t3-connect" as const } : {}),
          ...(route === "tailscale" ? { network: "tailscale" as const } : {}),
        }),
      ),
      enabled: true,
    })),
  ];
  it.effect.each(legacy)(
    "blocks $target.label without authorizing, fetching, or opening a tunnel",
    (entry) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(dependencies(calls)),
        );
        expect(yield* Effect.flip(resolver.prepare(entry))).toMatchObject({
          reason: "unsupported",
        });
        expect(yield* Effect.flip(resolver.prepareForUpdate(entry))).toMatchObject({
          reason: "unsupported",
        });
        expect(calls).toEqual([]);
      }),
  );
});
