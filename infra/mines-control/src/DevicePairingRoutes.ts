import { DevicePairingError } from "@t3tools/contracts/minesDevicePairing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DevicePairing from "./DevicePairing.ts";

const isPairingError = Schema.is(DevicePairingError);

export const handleDevicePairingRequest = Effect.fn("DevicePairingRoutes.handle")(
  function* (request: { readonly method: string; readonly body: unknown }) {
    if (request.method !== "POST") return { status: 404, value: { error: "not-found" } };
    const service = yield* DevicePairing.DevicePairing;
    return { status: 200, value: yield* service.execute(request.body) };
  },
  Effect.catch((error) =>
    Effect.succeed(
      isPairingError(error)
        ? {
            status: {
              "invalid-input": 400,
              forbidden: 403,
              "not-found": 404,
              expired: 410,
              conflict: 409,
              limit: 429,
              unavailable: 503,
            }[error.code],
            value: { error: error.code, message: error.message },
          }
        : { status: 503, value: { error: "unavailable" } },
    ),
  ),
);
