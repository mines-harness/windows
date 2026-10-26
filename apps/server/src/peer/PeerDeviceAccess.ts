export function peerDeviceAccessSubject(deviceId: string, requestId?: string): string {
  return `peer-device:${deviceId}${requestId ? `:${requestId}` : ""}`;
}
