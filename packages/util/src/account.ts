import { RLP } from '@ethereumjs/rlp'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'

import {
  bigIntToUnpaddedBytes,
  bytesToBigInt,
  bytesToHex,
  bytesToInt,
  concatBytes,
  equalsBytes,
  hexToBytes,
  intToUnpaddedBytes,
  toBytes,
  utf8ToBytes,
} from './bytes.ts'
import { BIGINT_0, KECCAK256_NULL, KECCAK256_RLP } from './constants.ts'
import { EthereumJSErrorWithoutCode } from './errors.ts'
import { assertIsBytes, assertIsHexString, assertIsString } from './helpers.ts'
import { stripHexPrefix } from './internal.ts'

import type { BigIntLike, BytesLike, NestedUint8Array, PrefixedHexString } from './types.ts'

export interface AccountData {
  nonce?: BigIntLike
  balance?: BigIntLike
  storageRoot?: BytesLike
  codeHash?: BytesLike
}

export interface PartialAccountData {
  nonce?: BigIntLike | null
  balance?: BigIntLike | null
  storageRoot?: BytesLike | null
  codeHash?: BytesLike | null
  codeSize?: BigIntLike | null
  version?: BigIntLike | null
}

export type AccountBodyBytes = [Uint8Array, Uint8Array, Uint8Array, Uint8Array]

/**
 * Handles the null indicator for RLP encoded accounts
 * @returns {null} is the null indicator is 0
 * @returns The unchanged value is the null indicator is 1
 * @throws if the null indicator is > 1
 * @throws if the length of values is < 2
 * @param value The value to convert
 * @returns The converted value
 */
function handleNullIndicator(values: NestedUint8Array | Uint8Array): Uint8Array | null {
  // Needed if some values are not provided to the array (e.g. partial account RLP)
  if (values[0] === undefined) {
    return null
  }

  const nullIndicator = bytesToInt(values[0] as Uint8Array)

  if (nullIndicator === 0) {
    return null
  }
  if (nullIndicator > 1) {
    throw EthereumJSErrorWithoutCode(`Invalid isNullIndicator=${nullIndicator}`)
  }
  if (values.length < 2) {
    throw EthereumJSErrorWithoutCode(`Invalid values length=${values.length}`)
  }
  return values[1] as Uint8Array
}

/**
 * Account class to load and maintain the  basic account objects.
 * Supports partial loading and access required for verkle with null
 * as the placeholder.
 *
 * Note: passing undefined in constructor is different from null
 * While undefined leads to default assignment, null is retained
 * to track the information not available/loaded because of partial
 * witness access
 */
export class Account {
  _nonce: bigint | null = null
  _balance: bigint | null = null
  _storageRoot: Uint8Array | null = null
  _codeHash: Uint8Array | null = null
  // codeSize and version is separately stored in VKT
  _codeSize: number | null = null
  _version: number | null = null

  get version() {
    if (this._version !== null) {
      return this._version
    } else {
      throw Error(`version=${this._version} not loaded`)
    }
  }
  set version(_version: number) {
    this._version = _version
  }

  get nonce() {
    if (this._nonce !== null) {
      return this._nonce
    } else {
      throw Error(`nonce=${this._nonce} not loaded`)
    }
  }
  set nonce(_nonce: bigint) {
    this._nonce = _nonce
  }

  get balance() {
    if (this._balance !== null) {
      return this._balance
    } else {
      throw Error(`balance=${this._balance} not loaded`)
    }
  }
  set balance(_balance: bigint) {
    this._balance = _balance
  }

  get storageRoot() {
    if (this._storageRoot !== null) {
      return this._storageRoot
    } else {
      throw Error(`storageRoot=${this._storageRoot} not loaded`)
    }
  }
  set storageRoot(_storageRoot: Uint8Array) {
    this._storageRoot = _storageRoot
  }

  get codeHash() {
    if (this._codeHash !== null) {
      return this._codeHash
    } else {
      throw Error(`codeHash=${this._codeHash} not loaded`)
    }
  }
  set codeHash(_codeHash: Uint8Array) {
    this._codeHash = _codeHash
  }

  get codeSize() {
    if (this._codeSize !== null) {
      return this._codeSize
    } else {
      throw Error(`codeSize=${this._codeSize} not loaded`)
    }
  }
  set codeSize(_codeSize: number) {
    this._codeSize = _codeSize
  }

  /**
   * This constructor assigns and validates the values.
   * It is not recommended to use this constructor directly. Instead use the static
   * factory methods to assist in creating an Account from varying data types.
   * undefined get assigned with the defaults, but null args are retained as is
   * @deprecated
   */
  constructor(
    nonce: bigint | null = BIGINT_0,
    balance: bigint | null = BIGINT_0,
    storageRoot: Uint8Array | null = KECCAK256_RLP,
    codeHash: Uint8Array | null = KECCAK256_NULL,
    codeSize: number | null = 0,
    version: number | null = 0,
  ) {
    this._nonce = nonce
    this._balance = balance
    this._storageRoot = storageRoot
    this._codeHash = codeHash

    if (codeSize === null && codeHash !== null && !this.isContract()) {
      codeSize = 0
    }
    this._codeSize = codeSize
    this._version = version

    this._validate()
  }

  private _validate() {
    if (this._nonce !== null && this._nonce < BIGINT_0) {
      throw EthereumJSErrorWithoutCode('nonce must be greater than zero')
    }
    if (this._balance !== null && this._balance < BIGINT_0) {
      throw EthereumJSErrorWithoutCode('balance must be greater than zero')
    }
    if (this._storageRoot !== null && this._storageRoot.length !== 32) {
      throw EthereumJSErrorWithoutCode('storageRoot must have a length of 32')
    }
    if (this._codeHash !== null && this._codeHash.length !== 32) {
      throw EthereumJSErrorWithoutCode('codeHash must have a length of 32')
    }
    if (this._codeSize !== null && this._codeSize < BIGINT_0) {
      throw EthereumJSErrorWithoutCode('codeSize must be greater than zero')
    }
  }

  /**
   * Returns an array of Uint8Arrays of the raw bytes for the account, in order.
   */
  raw(): Uint8Array[] {
    return [
      bigIntToUnpaddedBytes(this.nonce),
      bigIntToUnpaddedBytes(this.balance),
      this.storageRoot,
      this.codeHash,
    ]
  }

  /**
   * Returns the RLP serialization of the account as a `Uint8Array`.
   */
  serialize(): Uint8Array {
    return RLP.encode(this.raw())
  }

  serializeWithPartialInfo(): Uint8Array {
    const partialData = []
    const zeroEncoded = intToUnpaddedBytes(0)
    const oneEncoded = intToUnpaddedBytes(1)

    if (this._nonce !== null) {
      partialData.push([oneEncoded, bigIntToUnpaddedBytes(this._nonce)])
    } else {
      partialData.push([zeroEncoded])
    }

    if (this._balance !== null) {
      partialData.push([oneEncoded, bigIntToUnpaddedBytes(this._balance)])
    } else {
      partialData.push([zeroEncoded])
    }

    if (this._storageRoot !== null) {
      partialData.push([oneEncoded, this._storageRoot])
    } else {
      partialData.push([zeroEncoded])
    }

    if (this._codeHash !== null) {
      partialData.push([oneEncoded, this._codeHash])
    } else {
      partialData.push([zeroEncoded])
    }

    if (this._codeSize !== null) {
      partialData.push([oneEncoded, intToUnpaddedBytes(this._codeSize)])
    } else {
      partialData.push([zeroEncoded])
    }

    if (this._version !== null) {
      partialData.push([oneEncoded, intToUnpaddedBytes(this._version)])
    } else {
      partialData.push([zeroEncoded])
    }

    return RLP.encode(partialData)
  }

  /**
   * Returns a `Boolean` determining if the account is a contract.
   */
  isContract(): boolean {
    if (this._codeHash === null && this._codeSize === null) {
      throw Error(`Insufficient data as codeHash=null and codeSize=null`)
    }
    return (
      (this._codeHash !== null && !equalsBytes(this._codeHash, KECCAK256_NULL)) ||
      (this._codeSize !== null && this._codeSize !== 0)
    )
  }

  /**
   * Returns a `Boolean` determining if the account is empty complying to the definition of
   * account emptiness in [EIP-161](https://eips.ethereum.org/EIPS/eip-161):
   * "An account is considered empty when it has no code and zero nonce and zero balance."
   */
  isEmpty(): boolean {
    // helpful for determination in partial accounts
    if (
      (this._balance !== null && this.balance !== BIGINT_0) ||
      (this._nonce === null && this.nonce !== BIGINT_0) ||
      (this._codeHash !== null && !equalsBytes(this.codeHash, KECCAK256_NULL))
    ) {
      return false
    }

    return (
      this.balance === BIGINT_0 &&
      this.nonce === BIGINT_0 &&
      equalsBytes(this.codeHash, KECCAK256_NULL)
    )
  }
}

// Account constructors

export function createAccount(accountData: AccountData) {
  const { nonce, balance, storageRoot, codeHash } = accountData
  if (nonce === null || balance === null || storageRoot === null || codeHash === null) {
    throw Error(`Partial fields not supported in fromAccountData`)
  }

  return new Account(
    nonce !== undefined ? bytesToBigInt(toBytes(nonce)) : undefined,
    balance !== undefined ? bytesToBigInt(toBytes(balance)) : undefined,
    storageRoot !== undefined ? toBytes(storageRoot) : undefined,
    codeHash !== undefined ? toBytes(codeHash) : undefined,
  )
}

export function createAccountFromBytesArray(values: Uint8Array[]) {
  const [nonce, balance, storageRoot, codeHash] = values

  return new Account(bytesToBigInt(nonce), bytesToBigInt(balance), storageRoot, codeHash)
}

export function createPartialAccount(partialAccountData: PartialAccountData) {
  const { nonce, balance, storageRoot, codeHash, codeSize, version } = partialAccountData

  if (
    nonce === null &&
    balance === null &&
    storageRoot === null &&
    codeHash === null &&
    codeSize === null &&
    version === null
  ) {
    throw Error(`All partial fields null`)
  }

  return new Account(
    nonce !== undefined && nonce !== null ? bytesToBigInt(toBytes(nonce)) : nonce,
    balance !== undefined && balance !== null ? bytesToBigInt(toBytes(balance)) : balance,
    storageRoot !== undefined && storageRoot !== null ? toBytes(storageRoot) : storageRoot,
    codeHash !== undefined && codeHash !== null ? toBytes(codeHash) : codeHash,
    codeSize !== undefined && codeSize !== null ? bytesToInt(toBytes(codeSize)) : codeSize,
    version !== undefined && version !== null ? bytesToInt(toBytes(version)) : version,
  )
}

export function createAccountFromRLP(serialized: Uint8Array) {
  const values = RLP.decode(serialized) as Uint8Array[]

  if (!Array.isArray(values)) {
    throw EthereumJSErrorWithoutCode('Invalid serialized account input. Must be array')
  }

  return createAccountFromBytesArray(values)
}

export function createPartialAccountFromRLP(serialized: Uint8Array) {
  const values = RLP.decode(serialized)

  if (!Array.isArray(values)) {
    throw EthereumJSErrorWithoutCode('Invalid serialized account input. Must be array')
  }

  for (const value of values) {
    // Ensure that each array item is an array
    if (!Array.isArray(value)) {
      throw EthereumJSErrorWithoutCode('Invalid partial encoding. Each item must be an array')
    }
  }

  const [nonceRaw, balanceRaw, storageRoot, codeHash, codeSizeRaw, versionRaw] =
    values.map(handleNullIndicator)

  const nonce = nonceRaw === null ? null : bytesToBigInt(nonceRaw)
  const balance = balanceRaw === null ? null : bytesToBigInt(balanceRaw)
  const codeSize = codeSizeRaw === null ? null : bytesToInt(codeSizeRaw)
  const version = versionRaw === null ? null : bytesToInt(versionRaw)

  return createPartialAccount({ balance, nonce, storageRoot, codeHash, codeSize, version })
}

/**
 * Checks if the address is a valid. Accepts checksummed addresses too.
 */
export const isValidAddress = function (hexAddress: string): hexAddress is PrefixedHexString {
  try {
    assertIsString(hexAddress)
  } catch {
    return false
  }

  return /^0x[0-9a-fA-F]{40}$/.test(hexAddress)
}

/**
 * Returns a checksummed address.
 *
 * If an eip1191ChainId is provided, the chainId will be included in the checksum calculation. This
 * has the effect of checksummed addresses for one chain having invalid checksums for others.
 * For more details see [EIP-1191](https://eips.ethereum.org/EIPS/eip-1191).
 *
 * WARNING: Checksums with and without the chainId will differ and the EIP-1191 checksum is not
 * backwards compatible to the original widely adopted checksum format standard introduced in
 * [EIP-55](https://eips.ethereum.org/EIPS/eip-55), so this will break in existing applications.
 * Usage of this EIP is therefore discouraged unless you have a very targeted use case.
 */
export const toChecksumAddress = function (
  hexAddress: string,
  eip1191ChainId?: BigIntLike,
): PrefixedHexString {
  assertIsHexString(hexAddress)
  const address = stripHexPrefix(hexAddress).toLowerCase()

  let prefix = ''
  if (eip1191ChainId !== undefined) {
    const chainId = bytesToBigInt(toBytes(eip1191ChainId))
    prefix = chainId.toString() + '0x'
  }

  const bytes = utf8ToBytes(prefix + address)
  const hash = bytesToHex(keccak_256(bytes)).slice(2)
  let ret = ''

  for (let i = 0; i < address.length; i++) {
    if (parseInt(hash[i], 16) >= 8) {
      ret += address[i].toUpperCase()
    } else {
      ret += address[i]
    }
  }

  return `0x${ret}`
}

/**
 * Checks if the address is a valid checksummed address.
 *
 * See toChecksumAddress' documentation for details about the eip1191ChainId parameter.
 */
export const isValidChecksumAddress = function (
  hexAddress: string,
  eip1191ChainId?: BigIntLike,
): boolean {
  return isValidAddress(hexAddress) && toChecksumAddress(hexAddress, eip1191ChainId) === hexAddress
}

/**
 * Generates an address of a newly created contract.
 * @param from The address which is creating this new address
 * @param nonce The nonce of the from account
 */
export const generateAddress = function (from: Uint8Array, nonce: Uint8Array): Uint8Array {
  assertIsBytes(from)
  assertIsBytes(nonce)

  if (bytesToBigInt(nonce) === BIGINT_0) {
    // in RLP we want to encode null in the case of zero nonce
    // read the RLP documentation for an answer if you dare
    return keccak_256(RLP.encode([from, Uint8Array.from([])])).subarray(-20)
  }

  // Only take the lower 160bits of the hash
  return keccak_256(RLP.encode([from, nonce])).subarray(-20)
}

/**
 * Generates an address for a contract created using CREATE2.
 * @param from The address which is creating this new address
 * @param salt A salt
 * @param initCode The init code of the contract being created
 */
export const generateAddress2 = function (
  from: Uint8Array,
  salt: Uint8Array,
  initCode: Uint8Array,
): Uint8Array {
  assertIsBytes(from)
  assertIsBytes(salt)
  assertIsBytes(initCode)

  if (from.length !== 20) {
    throw EthereumJSErrorWithoutCode('Expected from to be of length 20')
  }
  if (salt.length !== 32) {
    throw EthereumJSErrorWithoutCode('Expected salt to be of length 32')
  }

  const address = keccak_256(concatBytes(hexToBytes('0xff'), from, salt, keccak_256(initCode)))

  return address.subarray(-20)
}

/**
 * Checks if the private key satisfies the rules of the curve secp256k1.
 */
export const isValidPrivate = function (privateKey: Uint8Array): boolean {
  return secp256k1.utils.isValidPrivateKey(privateKey)
}

/**
 * Checks if the public key satisfies the rules of the curve secp256k1
 * and the requirements of Ethereum.
 * @param publicKey The two points of an uncompressed key, unless sanitize is enabled
 * @param sanitize Accept public keys in other formats
 */
export const isValidPublic = function (publicKey: Uint8Array, sanitize: boolean = false): boolean {
  assertIsBytes(publicKey)
  if (publicKey.length === 64) {
    // Convert to SEC1 for secp256k1
    // Automatically checks whether point is on curve
    try {
      secp256k1.ProjectivePoint.fromHex(concatBytes(Uint8Array.from([4]), publicKey))
      return true
    } catch {
      return false
    }
  }

  if (!sanitize) {
    return false
  }

  try {
    secp256k1.ProjectivePoint.fromHex(publicKey)
    return true
  } catch {
    return false
  }
}

/**
 * Returns the ethereum address of a given public key.
 * Accepts "Ethereum public keys" and SEC1 encoded keys.
 * @param pubKey The two points of an uncompressed key, unless sanitize is enabled
 * @param sanitize Accept public keys in other formats
 */
export const pubToAddress = function (pubKey: Uint8Array, sanitize: boolean = false): Uint8Array {
  assertIsBytes(pubKey)
  if (sanitize && pubKey.length !== 64) {
    pubKey = secp256k1.ProjectivePoint.fromHex(pubKey).toRawBytes(false).slice(1)
  }
  if (pubKey.length !== 64) {
    throw EthereumJSErrorWithoutCode('Expected pubKey to be of length 64')
  }
  // Only take the lower 160bits of the hash
  return keccak_256(pubKey).subarray(-20)
}
export const publicToAddress = pubToAddress

/**
 * Returns the ethereum public key of a given private key.
 * @param privateKey A private key must be 256 bits wide
 */
export const privateToPublic = function (privateKey: Uint8Array): Uint8Array {
  assertIsBytes(privateKey)
  // skip the type flag and use the X, Y points
  return secp256k1.ProjectivePoint.fromPrivateKey(privateKey).toRawBytes(false).slice(1)
}

/**
 * Returns the ethereum address of a given private key.
 * @param privateKey A private key must be 256 bits wide
 */
export const privateToAddress = function (privateKey: Uint8Array): Uint8Array {
  return publicToAddress(privateToPublic(privateKey))
}

/**
 * Converts a public key to the Ethereum format.
 */
export const importPublic = function (publicKey: Uint8Array): Uint8Array {
  assertIsBytes(publicKey)
  if (publicKey.length !== 64) {
    publicKey = secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false).slice(1)
  }
  return publicKey
}

/**
 * Returns the zero address.
 */
export const zeroAddress = function (): PrefixedHexString {
  return bytesToHex(new Uint8Array(20))
}

/**
 * Checks if a given address is the zero address.
 */
export const isZeroAddress = function (hexAddress: string): boolean {
  try {
    assertIsString(hexAddress)
  } catch {
    return false
  }

  const zeroAddr = zeroAddress()
  return zeroAddr === hexAddress
}

export function accountBodyFromSlim(body: AccountBodyBytes) {
  const [nonce, balance, storageRoot, codeHash] = body
  return [
    nonce,
    balance,
    storageRoot.length === 0 ? KECCAK256_RLP : storageRoot,
    codeHash.length === 0 ? KECCAK256_NULL : codeHash,
  ]
}

const emptyUint8Arr = new Uint8Array(0)
export function accountBodyToSlim(body: AccountBodyBytes) {
  const [nonce, balance, storageRoot, codeHash] = body
  return [
    nonce,
    balance,
    equalsBytes(storageRoot, KECCAK256_RLP) ? emptyUint8Arr : storageRoot,
    equalsBytes(codeHash, KECCAK256_NULL) ? emptyUint8Arr : codeHash,
  ]
}

/**
 * Converts a slim account (per snap protocol spec) to the RLP encoded version of the account
 * @param body Array of 4 Uint8Array-like items to represent the account
 * @returns RLP encoded version of the account
 */
export function accountBodyToRLP(body: AccountBodyBytes, couldBeSlim = true) {
  const accountBody = couldBeSlim ? accountBodyFromSlim(body) : body
  return RLP.encode(accountBody)
}
