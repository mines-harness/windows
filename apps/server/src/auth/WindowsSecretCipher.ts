// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto does not provide authenticated encryption.
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

class WindowsSecretProtectionError extends Schema.TaggedError<WindowsSecretProtectionError>()(
  "WindowsSecretProtectionError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Windows credential protection is unavailable.";
  }
}

class WindowsCredentialKeyError extends Schema.TaggedError<WindowsCredentialKeyError>()(
  "WindowsCredentialKeyError",
  { reason: Schema.Literals(["missing-reference", "missing-credential", "invalid-credential"]) },
) {}

const MAGIC = Buffer.from("MINESWIN1\0");
const SERVICE = "Mines host secrets";
const keyIdentifier = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/u));
const decodeKeyIdentifier = Schema.decodeUnknownEffect(keyIdentifier);

export const make = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "win32") return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const keyReference = path.join(config.secretsDir, ".windows-keyring-v1");
  const keyLock = yield* Semaphore.make(1);
  let cachedKey: Buffer | undefined;

  const readReference = fs.readFileString(keyReference).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(cause),
    ),
  );
  const getKey = Effect.fn("WindowsSecretCipher.getKey")(
    function* (create: boolean) {
      if (cachedKey) return cachedKey;
      const { Entry } = yield* Effect.tryPromise(() => import("@napi-rs/keyring"));
      let reference = yield* readReference;
      if (Option.isNone(reference)) {
        if (!create)
          return yield* Effect.fail(new WindowsCredentialKeyError({ reason: "missing-reference" }));
        const id = yield* crypto.randomUUIDv4();
        const bytes = yield* crypto.randomBytes(32);
        const entry = yield* Effect.try(() => new Entry(SERVICE, id));
        yield* Effect.try(() => entry.setPassword(Buffer.from(bytes).toString("base64")));
        const temporary = `${keyReference}.${id}.tmp`;
        let published = false;
        yield* Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
              yield* file.writeAll(new TextEncoder().encode(id));
              yield* file.sync;
            }),
          );
          published = yield* fs.link(temporary, keyReference).pipe(
            Effect.as(true),
            Effect.catch((cause) =>
              cause.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(cause),
            ),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* fs.remove(temporary).pipe(Effect.ignore);
              if (!published) yield* Effect.try(() => entry.deletePassword()).pipe(Effect.ignore);
            }),
          ),
        );
        reference = yield* readReference;
      }
      if (Option.isNone(reference))
        return yield* Effect.fail(new WindowsCredentialKeyError({ reason: "missing-reference" }));
      const id = yield* decodeKeyIdentifier(reference.value);
      const encoded = yield* Effect.try(() => new Entry(SERVICE, id).getPassword());
      if (encoded === null)
        return yield* Effect.fail(new WindowsCredentialKeyError({ reason: "missing-credential" }));
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32)
        return yield* Effect.fail(new WindowsCredentialKeyError({ reason: "invalid-credential" }));
      cachedKey = key;
      return key;
    },
    keyLock.withPermit,
    Effect.uninterruptible,
    Effect.mapError((cause) => new WindowsSecretProtectionError({ cause })),
  );

  return {
    seal: Effect.fn("WindowsSecretCipher.seal")(function* (name: string, value: Uint8Array) {
      const key = yield* getKey(true);
      const nonce = yield* crypto
        .randomBytes(12)
        .pipe(Effect.mapError((cause) => new WindowsSecretProtectionError({ cause })));
      return yield* Effect.try({
        try: () => {
          const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
          cipher.setAAD(Buffer.from(name));
          const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
          return Uint8Array.from(
            Buffer.concat([MAGIC, Buffer.from(nonce), cipher.getAuthTag(), encrypted]),
          );
        },
        catch: (cause) => new WindowsSecretProtectionError({ cause }),
      });
    }),
    open: Effect.fn("WindowsSecretCipher.open")(function* (name: string, value: Uint8Array) {
      const bytes = Buffer.from(value);
      if (!bytes.subarray(0, MAGIC.length).equals(MAGIC))
        return { bytes: value, needsMigration: true };
      const key = yield* getKey(false);
      return yield* Effect.try({
        try: () => {
          if (bytes.length < MAGIC.length + 28)
            throw new Error("The protected secret is incomplete.");
          const nonce = bytes.subarray(MAGIC.length, MAGIC.length + 12);
          const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
          decipher.setAAD(Buffer.from(name));
          decipher.setAuthTag(bytes.subarray(MAGIC.length + 12, MAGIC.length + 28));
          return {
            bytes: Uint8Array.from(
              Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 28)), decipher.final()]),
            ),
            needsMigration: false,
          };
        },
        catch: (cause) => new WindowsSecretProtectionError({ cause }),
      });
    }),
  };
});
