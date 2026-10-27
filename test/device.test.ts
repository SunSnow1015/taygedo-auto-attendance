import { describe, expect, it } from 'vitest'
import { ensureAccountDevice, generateDeviceIdentity } from '../src/taygedo/device.js'

describe('device identity helpers', () => {
  it('generates a stable random device id and uppercase UUID fields', () => {
    const identity = generateDeviceIdentity()

    expect(identity.deviceId).toMatch(/^[a-f0-9]{32}$/)
    expect(identity.openudid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
    expect(identity.vendorid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
  })

  it('fills missing openudid and vendorid while reusing the existing device id', () => {
    const account = { id: 'main', name: '主账号', uid: '1', deviceId: 'device-existing', refreshToken: 'refresh' }
    const updated = ensureAccountDevice(account, {
      generate: () => ({ deviceId: 'device-new', openudid: 'OPEN-NEW', vendorid: 'VENDOR-NEW' }),
    })

    expect(updated).toEqual({
      ...account,
      openudid: 'OPEN-NEW',
      vendorid: 'VENDOR-NEW',
    })
  })

  it('reuses a complete existing identity by default', () => {
    const account = {
      id: 'main',
      name: '主账号',
      uid: '1',
      deviceId: 'device-existing',
      openudid: 'OPEN-OLD',
      vendorid: 'VENDOR-OLD',
      refreshToken: 'refresh',
    }

    expect(ensureAccountDevice(account, {
      generate: () => ({ deviceId: 'device-new', openudid: 'OPEN-NEW', vendorid: 'VENDOR-NEW' }),
    })).toEqual(account)
  })

  it('replaces all device fields when force is enabled', () => {
    const account = {
      id: 'main',
      name: '主账号',
      uid: '1',
      deviceId: 'device-existing',
      openudid: 'OPEN-OLD',
      vendorid: 'VENDOR-OLD',
      refreshToken: 'refresh',
    }

    expect(ensureAccountDevice(account, {
      force: true,
      generate: () => ({ deviceId: 'device-new', openudid: 'OPEN-NEW', vendorid: 'VENDOR-NEW' }),
    })).toEqual({
      ...account,
      deviceId: 'device-new',
      openudid: 'OPEN-NEW',
      vendorid: 'VENDOR-NEW',
    })
  })
})
