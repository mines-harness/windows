import { getPeerDevices } from "@t3tools/shared/minesPeerSignaling";
import { useEffect, useState } from "react";

import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { minesControlUrl } from "../../cloud/publicConfig";
import {
  failAccountPeerDirectory,
  readAccountPeerDirectory,
  type AccountPeerDirectoryState,
} from "./accountPeerDirectory.logic";

export function useAccountPeerDirectory() {
  const { isSignedIn, userId, getToken } = useMinesAuth();
  const accountId = isSignedIn ? userId : null;
  const controlUrl = minesControlUrl();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<AccountPeerDirectoryState>({
    accountId: null,
    controlUrl: null,
    data: null,
    requestKey: "",
    error: null,
  });
  const requestKey = JSON.stringify([accountId, controlUrl, revision]);

  useEffect(() => {
    if (!accountId || !controlUrl) return;
    let active = true;
    void getPeerDevices({
      controlUrl,
      bearerToken: async () => {
        const token = await getToken();
        if (!active || !token) throw new Error("Sign in to Mines to see your devices.");
        return token;
      },
    }).then(
      (data) => {
        if (active) setState({ accountId, controlUrl, data, requestKey, error: null });
      },
      () => {
        if (active)
          setState((previous) =>
            failAccountPeerDirectory(
              previous,
              { accountId, controlUrl, requestKey },
              "Device presence could not be loaded. Check your connection or sign in again.",
            ),
          );
      },
    );
    return () => {
      active = false;
    };
  }, [accountId, controlUrl, getToken, requestKey]);

  return {
    ...readAccountPeerDirectory(state, { accountId, controlUrl, requestKey }),
    refresh: () => setRevision((value) => value + 1),
  };
}
