import { describe, expect, it } from 'vitest';
import { FakeServer } from './server';

const reg = (s: FakeServer, username = 'alice', key = [1]) =>
  s.clientFor(() => null).register({ username, authKey: new Uint8Array(key), kdf: 'pbkdf2-sha256', iterations: 600000, wrappedVaultKey: new Uint8Array([7]), deviceName: 'A' });

describe('FakeServer', () => {
  it('versions the vault with create-only and If-Match semantics', async () => {
    const s = new FakeServer();
    const sess = await reg(s);
    const c = s.clientFor(() => sess.deviceToken);
    expect(await c.getVault()).toEqual({ status: 'empty' });
    expect(await c.putVault(new Uint8Array([1]), 1)).toEqual({ status: 'conflict', currentVersion: 0 });
    expect(await c.putVault(new Uint8Array([1]), 'none')).toEqual({ status: 'ok', version: 1 });
    expect(await c.putVault(new Uint8Array([2]), 'none')).toEqual({ status: 'conflict', currentVersion: 1 });
    expect(await c.putVault(new Uint8Array([2]), 1)).toEqual({ status: 'ok', version: 2 });
    expect(await c.getVault(2)).toEqual({ status: 'not_modified' });
    expect(await c.getVault(1)).toMatchObject({ status: 'ok', version: 2 });
    expect((await c.listVersions()).map((v) => v.version)).toEqual([2, 1]);
    expect(await c.getVersion(1)).toEqual(new Uint8Array([1]));
  });

  it('runs the beforePut hook to simulate a concurrent writer', async () => {
    const s = new FakeServer();
    const sess = await reg(s);
    const c = s.clientFor(() => sess.deviceToken);
    await c.putVault(new Uint8Array([1]), 'none');
    s.beforePut = () => {
      s.beforePut = null;
      s.forcePut(sess.userId, new Uint8Array([9]));
    };
    expect(await c.putVault(new Uint8Array([2]), 1)).toEqual({ status: 'conflict', currentVersion: 2 });
  });

  it('logs in, rejects wrong keys and revokes devices', async () => {
    const s = new FakeServer();
    const first = await reg(s);
    await expect(s.clientFor(() => null).login({ username: 'alice', authKey: new Uint8Array([2]), deviceName: 'B' })).rejects.toMatchObject({ code: 'invalid_credentials' });
    const second = await s.clientFor(() => null).login({ username: 'alice', authKey: new Uint8Array([1]), deviceName: 'B' });
    expect(second.wrappedVaultKey).toEqual(new Uint8Array([7]));
    await s.clientFor(() => first.deviceToken).revokeDevice(second.deviceId);
    await expect(s.clientFor(() => second.deviceToken).getVault()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('changes the password, revoking other devices, with optional rotation', async () => {
    const s = new FakeServer();
    const first = await reg(s);
    const second = await s.clientFor(() => null).login({ username: 'alice', authKey: new Uint8Array([1]), deviceName: 'B' });
    const c = s.clientFor(() => first.deviceToken);
    await c.putVault(new Uint8Array([1]), 'none');
    await c.putVault(new Uint8Array([2]), 1);
    const req = { currentAuthKey: new Uint8Array([1]), newAuthKey: new Uint8Array([3]), kdf: 'pbkdf2-sha256', iterations: 600000, newWrappedVaultKey: new Uint8Array([8]) };
    await expect(c.changePassword({ ...req, rotation: { expectedVersion: 1, vault: new Uint8Array([9]) } })).rejects.toMatchObject({ code: 'version_conflict', currentVersion: 2 });
    expect(await c.changePassword({ ...req, rotation: { expectedVersion: 2, vault: new Uint8Array([9]) } })).toEqual({ version: 3 });
    expect((await c.listVersions()).map((v) => v.version)).toEqual([3]);
    await expect(s.clientFor(() => second.deviceToken).getVault()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(s.userByName('alice')!.wrappedVaultKey).toEqual(new Uint8Array([8]));
  });

  it('simulates a backup restore with rollbackTo', async () => {
    const s = new FakeServer();
    const sess = await reg(s);
    const c = s.clientFor(() => sess.deviceToken);
    await c.putVault(new Uint8Array([1]), 'none');
    await c.putVault(new Uint8Array([2]), 1);
    s.rollbackTo(sess.userId, 1);
    expect(await c.getVault()).toMatchObject({ status: 'ok', version: 1 });
  });

  it('goes offline on request', async () => {
    const s = new FakeServer();
    s.offline = true;
    await expect(s.clientFor(() => null).prelogin('x')).rejects.toMatchObject({ code: 'network' });
  });
});
