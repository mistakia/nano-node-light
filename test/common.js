/* global describe it */
import chai from 'chai'

import { decode_address } from '#common'

const { expect } = chai

describe('common', () => {
  it('decode_address', () => {
    const address =
      'nano_1111111111111111111111111111111111111111111111111111hifc8npp'
    const { public_key, checksum } = decode_address({ address })

    expect(public_key).to.equal(
      '0000000000000000000000000000000000000000000000000000000000000000'
    )
    expect(checksum).to.equal('7c1aa352d6')
  })
})
