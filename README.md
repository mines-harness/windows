<p align="center"><img src="https://raw.githubusercontent.com/mines-harness/macos/main/assets/mines/icon-256.png" width="96" height="96" alt="Mines" /></p>

<h1 align="center">mines for Windows</h1>

<p align="center">Your coding agents. Your subscriptions. Your computers.</p>

Mines is a workspace for coding agents across desktop, web, command-line hosts, and mobile companions. This repository preserves earlier Windows platform work. **Active Windows, macOS, Linux, and CLI development and releases use the [shared monorepo](https://github.com/mines-harness/macos).** Platform differences are recorded by its [source parity report](https://github.com/mines-harness/macos/actions/workflows/mines-source-parity.yml); this snapshot is not a separate release train.

Windows and macOS use the same Electron and React application. Native integration, installer identity, signing, executable archives, terminal support, and system permissions require platform-specific validation. A successful macOS release does not certify a Windows binary; compare the release's source revision and validation before upgrading.

## Shared desktop interface

![Mines web composer](https://raw.githubusercontent.com/mines-harness/macos/main/assets/showcase/web-composer.png)

Web development capture of the shared interface with an example unsent draft. This image is not a Windows package validation.

## Develop

Use the Node and pnpm versions pinned in the canonical monorepo.

```sh
git clone https://github.com/mines-harness/macos.git mines
cd mines
pnpm install --frozen-lockfile
pnpm dev:desktop
```

Read the [development guide](docs/operations/development.md) and [unified release procedure](https://github.com/mines-harness/macos/blob/main/docs/operations/mines-release.md) before packaging. Keep development state separate from an installed app's data directory.

## Across devices

Run agents through their native provider tools, organize mines and projects in the Library, and connect from approved devices. Provider capabilities depend on the runtime and account connected to the host. Direct WebRTC access depends on the network and an awake host.

[Shared source and docs](https://github.com/mines-harness/macos) · [Unified releases](https://github.com/mines-harness/macos/releases) · [Android](https://github.com/mines-harness/android) · [iOS](https://github.com/mines-harness/ios)

## License

Built on [T3 Code](https://github.com/pingdotgg/t3code). The original [MIT license](LICENSE) and third-party notices are retained. Mines is independently maintained.
