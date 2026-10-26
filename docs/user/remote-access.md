# Remote access

Connect a phone, browser, or another desktop app to mines running on a different
machine. The host must stay awake, running, and reachable for live work.

<a id="t3-connect"></a>

## Account and direct access

Mines accounts, sign-up, and login are hosted by your configured Mines service.
Account-based device discovery and direct access also require its HTTPS
device service and STUN server. The repository includes deployment guidance for
the [device service](../../infra/mines-control/README.md); it does not provide a
running public service. Local work and LAN pairing remain available without it.

Sign in to the same mines account on both computers. Open **Settings → Devices**
to see them together. Turn on **Allow connections** on the computer you want to
access, then choose **Connect** beside it on your other computer. Approve the
matching short code on the host; mines finishes setup automatically. You can
decline a request or revoke a device's access on the same page.

Signing in makes a computer discoverable but does not grant access to it. The
menu bar shows the same devices and distinguishes availability from an active
connection. Manual network and pairing options remain under **Advanced**. Mobile
clients retain their existing device approval and pairing-code flow.

For a command-line host, start the host, then run:

```bash
mines account login --no-browser
```

Open the displayed link on a device with a browser, sign in, and approve the code.
The CLI then registers the host with the same account. If the host uses a custom
data directory, pass the same `--base-dir` to these commands.

When another computer requests access, approve its displayed short code over SSH:

```bash
mines devices approve ABCD2345
```

Use `mines devices pending` to review requests and `mines devices deny ABCD2345`
to decline one. Each code expires shortly and authorizes only the requesting
device. The requesting computer completes its connection without copying a
pairing link.

Use `mines account status` to inspect the account and signaling connection, and
`mines devices list` to see account devices and their last direct checks. Run
`mines devices check <device-id>` to test an approved device. Signaling presence
alone does not confirm a direct connection. `mines account logout` clears this
CLI's sign-in and stops account sharing on its matching running host.

Approved devices exchange conversation history, catalog changes, files, and
commands over direct WebRTC connections. The device service handles registration,
presence, and connection negotiation; it does not relay or queue conversation text.
There is no automatic TURN, managed tunnel, or SSH fallback for a failed peer
connection. Try another network, retry later, or read history already cached on
that device. Uncached content and live controls need the host to reconnect.

A sleeping host cannot serve live history. Mobile operating systems may suspend
the app in the background; reconnect when it returns to the foreground. Optional
[generic notifications](./mobile-notifications.md) use a separate push service.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Devices → Advanced**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
mines serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
mines pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Manual connection settings are under **Settings → Devices → Advanced**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Devices page stays open. If you leave or reload that page, create
another link to share.

### Reach one machine several ways

A machine can have separately configured LAN, private-network, Tailscale, or SSH
routes. Pairing the same machine over another address adds a route instead of a
second machine. On web and desktop, open its route list in **Settings →
Devices → Advanced** to inspect, reorder, or remove routes. On mobile, open the machine
under **Settings → Environments** and choose **Edit**.

A reachable route can be selected explicitly when a peer connection fails; mines
does not turn a direct peer session into a relay session. LAN access still needs
to be enabled on the host. A loopback address always refers to the device opening
it, not the remote computer.

Open **Permissions** next to **Routes** on web or desktop, or **Your permissions**
in mobile route details, to see what the route marked **In use** permits. Pairing
sessions can have different grants; grouping machines does not combine access.

<a id="balance-new-threads-across-machines"></a>

### Balance new mines across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Devices → Advanced → Load balancing** to automatically choose a machine for
new mines in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing mines stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
mines serve --tailscale-serve
```

For an already-running server:

```bash
mines pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `mines pair --help` for other pairing options.

### Hosted web app

mines has no public hosted web app configured by default. Use the web app served
by your own host, or a hosted origin supplied by your mines distributor. A hosted
HTTPS page needs a reachable HTTPS endpoint; it cannot make a private backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use its direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an address without a scheme
uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Devices → Add device**, enter an SSH host or
alias such as `user@example.com`, and connect. mines installs or reuses a server
there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
Automatic SSH installation requires your distributor’s own mines release source.
Without one, installation is unavailable; mines does not download the upstream
server. A configured installation stores its runtime under `~/.mines/runtime`.
When an update is available, use **Update CLI** beside the SSH computer on the
Devices page. Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that mines launched; a server that was already
running is left alone.

Each desktop app keeps one session on the host for its SSH connection and reuses
it when it reconnects. Revoke sessions you no longer use in **Settings →
Connections** on the host, or on a headless host with `mines auth session list` and
`mines auth session revoke <id>`. A desktop that can still sign in over SSH pairs
again on its next connect. Manual session controls are under **Devices → Advanced**.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Browser on a remote environment

Browser tabs belong to the environment, so you and your agents see the same
tabs from any device. The desktop app shows its own environment's tabs
directly. Every other device, and the desktop app for other environments,
streams them from the host. Agents keep using them while no device is
connected, and `localhost` addresses reach servers on the host.

The first tab downloads a headless Chrome, about 120 MB, into the mines home. It
is the same browser [HTML renders](html-renders.md) use, so a host downloads it
only once. Some Linux hosts need [setup](#browser-host-setup) before it can
start.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay on the host until the
tab closes. Audio does not play on your device.

On a phone, tap the floating preview's corner dot to show its controls, then
**Pop into separate window** to keep watching in picture-in-picture over other
apps.

### Browser host setup

macOS, Windows, and Linux desktops run the browser as is. Some Linux hosts need
one-time setup: Ubuntu 23.10 and later block the sandbox the browser runs in,
and minimal images and containers lack libraries it loads. When that happens,
the server says so at startup, and browser tabs and HTML previews show the
command to run on the host:

```sh
sudo mines browser setup
```

The server shows the exact line for how you started it, such as
`sudo mines browser setup`, and keeps your `PATH` when Node is installed only
for your user. Where `mines` is not on your `PATH`, such as with only the
desktop app installed, it names the full path of the bundled command instead. It allows Chrome's sandbox with an AppArmor profile and installs
any missing libraries and system fonts with apt; pages that load without text
can mean the host has no fonts. It is safe to run again. Without `sudo`, it only
reports what it would change.

The browser always runs in Chrome's sandbox. Where you cannot change the host,
set `MINES_SERVER_BROWSER_SANDBOX=0` for the environment to run without it.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents mines did not start can drive
mines on an environment through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `mines auth --help`.

A session with an open connection stays listed after its access credential
expires.

To choose a token's permissions, pass `--scope` once for each scope you want:

```sh
mines pair --scope orchestration:read --scope relay:read
```

The selected scopes replace the default permissions. The same option works with
`mines auth pairing create` and `mines auth session issue`; each command's
`--help` lists the available scopes. Without `--scope`, pairing tokens and issued
bearer sessions get every permission, including managing access and configured connections.
A terminal or a full-access agent on the host can reach those as well, so a
client that should not manage access also needs to go without `terminal:operate`
and `orchestration:operate`.

To change an existing client's permissions, create a fresh pairing link with the
scopes it needs. In a browser opened directly on the environment, open that link
to replace the browser's current grant. For mobile or a saved remote environment
in web or desktop, use **Add Environment** with the fresh link or code; pairing
the same environment replaces its saved grant. Reconnecting alone does not change
permissions.

Grouping checkouts does not combine their permissions. Shared project settings
require `orchestration:operate` on every member environment; actions on one
checkout use that checkout's permissions.

`source-control:write` covers direct Git and pull request changes made from the
client: pushing, switching or creating branches, cloning, and removing
worktrees. It does not restrict what a task does. Starting a task in a new
worktree still creates that branch and worktree with `orchestration:operate`,
and the agent it runs can use Git however the environment allows.

Settings changes, provider management, environment maintenance, access
management, and legacy relay management can each be granted separately. New
pairings without `--scope` include all of them. Existing clients keep the
permissions they paired with and can stay connected after an update, but newly
separated features may require pairing again with the permissions they need.
Older clients may show controls that the server denies. Create a fresh pairing
link to change a client's permissions.

`filesystem:read` allows browsing host files, opening workspace files, and viewing
local changes. Add `filesystem:write` to allow editing files or saving plans to
the workspace. These scopes control direct file access from the client.

To remove direct peer access, revoke the device on the host. Also remove its
account registration in device settings to stop new signaling. Removing a saved
route only forgets that route on the client. Signing out clears that client’s
account-specific peer bindings; it does not stop agents already running on a host.

## Optional legacy managed endpoints

The inherited managed-endpoint and guest-link features are unconfigured by
default. They need a separately operated compatible relay, its own authentication
configuration, and a reachable managed endpoint. The mines device service is not
that relay. Configuring one is an explicit deployment choice and does not add an
automatic fallback to direct peer connections. Upstream T3 Connect credentials,
tunnels, and service availability are not included.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

<a id="t3-connect-troubleshooting"></a>

## Connection troubleshooting

See [connection troubleshooting](./t3-connect-troubleshooting.md) for account,
peer approval, network, and host-availability checks.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. mines restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through configured remote routes.

Switch **Local environment** back on in the same place to restart with your previous local
settings.

## Groups across computers in mines

A group has one coordinator computer. Each member mine stays on its original computer, provider account and workspace. Group messages and replies use the approved direct peer connection; the account server carries device discovery and connection negotiation.

1. Enable direct access on both computers and approve their device codes.
2. On the member's computer, create a fresh pairing code for the coordinator.
3. On the coordinator, open **Settings → Connections → Groups across computers**, paste that code, verify the displayed device fingerprint, and choose **Approve and connect**.
4. Repeat in the other direction so the member can notify the coordinator and ask other members to contribute.
5. Keep the remote environment connected in the app so its mine list is available. In **Create a group**, select mines from the connected computers, set their mention names and optional roles, and choose a lead.

Pairing grants this coordinator permission to read and operate agent mines on the other computer. Mines exchanges the one-time code directly and stores the resulting credential in the coordinator's protected secret store. **Disconnect** removes the saved route and credential; the other computer's access settings can revoke the corresponding client session too.

Both computers must remain awake. If a direct connection is unavailable, the member is shown as unavailable and can be retried after reconnection. Group message text does not fall back to the account server. Unsent messages and unfinished group setup are saved locally on the device running the app; retrying an unchanged draft preserves its request identity.
