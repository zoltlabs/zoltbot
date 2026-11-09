declare module "noise-handshake" {
  export interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }
  export default class Noise {
    constructor(pattern: "IK", initiator: boolean, staticKeypair?: KeyPair);
    s: KeyPair;
    e: KeyPair | null;
    rs: Uint8Array | null;
    tx: Uint8Array | null;
    rx: Uint8Array | null;
    hash: Uint8Array | null;
    complete: boolean;
    initialise(prologue: Uint8Array, remoteStatic?: Uint8Array): void;
    send(payload?: Uint8Array): Uint8Array;
    recv(message: Uint8Array): Uint8Array;
  }
}

declare module "noise-handshake/cipher.js" {
  export default class Cipher {
    constructor(key: Uint8Array);
    key: Uint8Array;
    nonce: number;
    setNonce(nonce: number): void;
    encrypt(plaintext: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array): Uint8Array;
  }
}
