import { RLP } from '@ethereumjs/rlp'
import { BIGINT_0, BIGINT_1, EthereumJSErrorWithoutCode, concatBytes } from '@ethereumjs/util'
import { keccak_256 } from '@noble/hashes/sha3'

import { txTypeBytes } from '../util/internal.ts'

import { errorMsg } from './legacy.ts'

import type { Input } from '@ethereumjs/rlp'
import type { EIP2718CompatibleTx } from '../types.ts'

export function getHashedMessageToSign(tx: EIP2718CompatibleTx): Uint8Array {
  const keccakFunction = tx.common.customCrypto.keccak256 ?? keccak_256
  return keccakFunction(tx.getMessageToSign())
}

export function serialize(tx: EIP2718CompatibleTx, base?: Input): Uint8Array {
  return concatBytes(txTypeBytes(tx.type), RLP.encode(base ?? tx.raw()))
}

export function validateYParity(tx: EIP2718CompatibleTx) {
  const { v } = tx
  if (v !== undefined && v !== BIGINT_0 && v !== BIGINT_1) {
    const msg = errorMsg(tx, 'The y-parity of the transaction should either be 0 or 1')
    throw EthereumJSErrorWithoutCode(msg)
  }
}
