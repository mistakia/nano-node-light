/* global describe it */
import chai from 'chai'

import BoundedCache from '#common/bounded-cache.js'

const { expect } = chai

describe('Bounded Cache', () => {
  it('holds at most the maximum entry count', () => {
    const cache = new BoundedCache({ maximum_entry_count: 3 })
    for (let i = 0; i < 10; i++) cache.set(`key_${i}`)
    expect(cache.size).to.equal(3)
  })

  it('evicts the oldest entries first', () => {
    const cache = new BoundedCache({ maximum_entry_count: 2 })
    cache.set('a')
    cache.set('b')
    cache.set('c')
    expect(cache.has('a')).to.equal(false)
    expect(cache.has('b')).to.equal(true)
    expect(cache.has('c')).to.equal(true)
  })

  it('keeps the insertion position of a key set twice', () => {
    const cache = new BoundedCache({ maximum_entry_count: 2 })
    cache.set('a')
    cache.set('b')
    cache.set('a')
    cache.set('c')
    expect(cache.has('a')).to.equal(false)
    expect(cache.has('b')).to.equal(true)
  })

  it('refuses a non-positive maximum', () => {
    expect(() => new BoundedCache({ maximum_entry_count: 0 })).to.throw()
  })
})
