import * as jose from 'jose';

// This is a simple, non-persistent key store.
// In a real production environment, you should not generate keys on startup.
// You should generate them once and store them securely.
let privateJwks: jose.JSONWebKeySet | undefined;
let publicJwks: jose.JSONWebKeySet | undefined;

async function ensureKeys() {
  if (privateJwks && publicJwks) {
    return;
  }

  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const publicJwk = await jose.exportJWK(publicKey);
  const privateJwk = await jose.exportJWK(privateKey);
  const kid = await jose.calculateJwkThumbprint(publicJwk);

  privateJwks = {
    keys: [
      {
        ...privateJwk,
        kid,
        alg: 'RS256',
        use: 'sig',
      },
    ],
  };

  publicJwks = {
    keys: [
      {
        ...publicJwk,
        kid,
        alg: 'RS256',
        use: 'sig',
      },
    ],
  };
}

export async function getJwks() {
  await ensureKeys();
  return privateJwks!;
}

export async function getPublicJwks() {
  await ensureKeys();
  return publicJwks!;
}
