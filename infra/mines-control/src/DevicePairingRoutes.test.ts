import { expect, it } from "@effect/vitest";
import { DevicePairingError } from "@t3tools/contracts/minesDevicePairing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DevicePairing from "./DevicePairing.ts";
import { handleDevicePairingRequest } from "./DevicePairingRoutes.ts";

it.effect("passes the signed body to the pairing service without account spoofing", () => {
  const body = { action: "pending", accountId: "spoofed-account" };
  return handleDevicePairingRequest({ method: "POST", body }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => expect(result).toEqual({ status: 200, value: { requests: [] } })),
    ),
    Effect.provide(
      Layer.mock(DevicePairing.DevicePairing, {
        execute: (received) => {
          expect(received).toBe(body);
          return Effect.succeed({ requests: [] });
        },
      }),
    ),
  );
});

it.effect("maps pairing failures to bounded safe HTTP responses", () =>
  Effect.gen(function* () {
    for (const [code, status] of [
      ["invalid-input", 400],
      ["forbidden", 403],
      ["not-found", 404],
      ["expired", 410],
      ["conflict", 409],
      ["limit", 429],
      ["unavailable", 503],
    ] as const) {
      const error = new DevicePairingError({ code });
      const result = yield* handleDevicePairingRequest({ method: "POST", body: {} }).pipe(
        Effect.provide(
          Layer.mock(DevicePairing.DevicePairing, { execute: () => Effect.fail(error) }),
        ),
      );
      expect(result).toEqual({ status, value: { error: code, message: error.message } });
    }
  }),
);

it.effect("rejects unsupported HTTP methods without calling the pairing service", () =>
  handleDevicePairingRequest({ method: "GET", body: undefined }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => expect(result).toEqual({ status: 404, value: { error: "not-found" } })),
    ),
    Effect.provide(Layer.mock(DevicePairing.DevicePairing, {})),
  ),
);
