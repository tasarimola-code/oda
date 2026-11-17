import { isFingerprint } from './invite';
import { isValidHost, isValidPort } from './netclass';

export interface ServerTarget {
  hostId: string;
  hostName: string;
  addresses: string[];
  port: number;
  /** SHA-256 of the server's TLS certificate; the connection is refused if it differs. */
  fingerprint: string;
}

/** The ODA server every installation uses for accounts, rooms and voice. */
export const DEFAULT_SERVER: ServerTarget = {
  hostId: 'L6a7KGbsLmpm06tRx8cLDQ',
  hostName: 'ODA Sunucusu',
  addresses: ['5.199.136.47'],
  port: 47823,
  fingerprint: '71:6F:D5:77:B1:22:19:C2:CA:EF:ED:13:95:B7:16:AB:CD:2D:6F:59:CB:81:4C:31:9A:D9:2B:D7:4C:CF:65:B7',
};

/**
 * `ODA_SERVER=hostId|name|address|port|fingerprint` points the app at another server (tests, self-hosting).
 * Invalid values are ignored.
 */
export function resolveDefaultServer(override: string | undefined): ServerTarget {
  if (!override) return DEFAULT_SERVER;
  const [hostId, hostName, address, port, fingerprint] = override.split('|');
  const p = Number(port);
  if (!hostId || !/^[A-Za-z0-9_-]{8,64}$/.test(hostId) || !hostName || !isValidHost(address ?? '') || !isValidPort(p) || !isFingerprint(fingerprint)) return DEFAULT_SERVER;
  return { hostId, hostName: hostName.slice(0, 40), addresses: [address], port: p, fingerprint };
}
