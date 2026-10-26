import type { PeerDevicePlatform } from "@t3tools/contracts/minesPeer";
import { MonitorIcon, SmartphoneIcon } from "lucide-react";
import { AndroidIcon, AppleIcon, LinuxIcon } from "./Icons";

export function PeerDeviceIcon({
  platform,
  className,
}: {
  readonly platform?: PeerDevicePlatform | undefined;
  readonly className?: string;
}) {
  switch (platform) {
    case "android":
      return <AndroidIcon className={className} />;
    case "ios":
      return <SmartphoneIcon className={className} aria-hidden="true" />;
    case "macos":
      return <AppleIcon className={className} />;
    case "linux":
      return <LinuxIcon className={className} aria-hidden="true" />;
    case "windows":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M2 3h9v8H2zm11 0h9v8h-9zM2 13h9v8H2zm11 0h9v8h-9z" />
        </svg>
      );
    default:
      return <MonitorIcon className={className} aria-hidden="true" />;
  }
}
