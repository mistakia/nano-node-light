/* global describe it */
import chai from 'chai'

import { decodeAddress } from '#common'

const { expect } = chai

describe('common', () => {
  it('decode_address', () => {
    const address =
      'nano_1111111111111111111111111111111111111111111111111111hifc8npp'
    const { publicKey, checksum } = decodeAddress({ address })

    expect(publicKey).to.equal(
      '0000000000000000000000000000000000000000000000000000000000000000'
    )
    expect(checksum).to.equal('7c1aa352d6')
  })
})
