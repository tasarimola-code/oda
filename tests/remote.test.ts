import { describe, expect, it } from 'vitest';
import { connectClient } from './helpers';
import { generateDeviceKey } from '../src/main/client/profile';
import { decodeInvite } from '../src/shared/invite';

// Optional check against a deployed server: ODA_REMOTE_CODE=ODA1-… npx vitest run tests/remote.test.ts
// Only decodes the invite (address, fingerprint, server id); the invite itself is not used up.
const code = process.env.ODA_REMOTE_CODE?.trim();

describe.skipIf(!code)('deployed ODA server', () => {
  it('passes the pinned TLS check, announces itself as an ODA server and reaches sign-in', async () => {
    const inv = decodeInvite(code!);
    expect(inv).not.toBeNull();
    const key = generateDeviceKey();
    const r = await connectClient({
      hostId: inv!.h,
      port: inv!.p,
      fingerprint: inv!.f,
      addresses: inv!.a,
      requireServer: true,
      auth: { kind: 'login', publicKey: key.publicKey, privateKeyPem: key.privateKeyPem },
    });
    r.client.disconnect();
    expect(r.status.error?.code).toBe('DEVICE_UNKNOWN');
  }, 20_000);
});
