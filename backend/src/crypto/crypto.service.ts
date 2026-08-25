import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';

export interface EncryptedPayload {
  encryptedKey: string; // Base64 RSA-OAEP encrypted AES key
  iv: string;           // Hex AES-GCM IV (12 bytes)
  tag: string;          // Hex AES-GCM Auth Tag (16 bytes)
  ciphertext: string;   // Base64 AES-GCM encrypted payload
}

@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private publicKeyPem!: string;
  private privateKeyPem!: string;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.initKeys();
  }

  /**
   * Initializes RSA-2048 key pair from environment or generates transient keys if missing.
   */
  public initKeys() {
    let pub = this.configService.get<string>('RSA_PUBLIC_KEY');
    let priv = this.configService.get<string>('RSA_PRIVATE_KEY');

    if (pub && priv) {
      this.publicKeyPem = pub.replace(/\\n/g, '\n');
      this.privateKeyPem = priv.replace(/\\n/g, '\n');
      this.logger.log('[CRYPTO] RSA-OAEP keys loaded from environment.');
    } else {
      this.logger.warn('[CRYPTO] RSA keys not found in env. Generating 2048-bit RSA-OAEP keypair...');
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      this.publicKeyPem = publicKey;
      this.privateKeyPem = privateKey;
      this.logger.log('[CRYPTO] Transient RSA-2048 key pair initialized.');
    }
  }

  public getPublicKeyPem(): string {
    return this.publicKeyPem;
  }

  /**
   * Encrypts arbitrary payload (data in-transit or data-at-rest).
   * 1. Generates 32-byte AES-256-GCM symmetric key & 12-byte IV.
   * 2. Encrypts payload with AES-256-GCM.
   * 3. Encrypts the 32-byte AES key using RSA-OAEP (SHA-256).
   */
  public encryptPayload(data: any, customPublicKeyPem?: string): EncryptedPayload {
    const pubKey = customPublicKeyPem || this.publicKeyPem;
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);

    // 1. Generate random AES-256 key (32 bytes) and IV (12 bytes)
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    // 2. Encrypt payload with AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertextBuffer = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // 3. Encrypt AES key using RSA-OAEP (SHA-256)
    const encryptedKeyBuffer = crypto.publicEncrypt(
      {
        key: pubKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      aesKey
    );

    return {
      encryptedKey: encryptedKeyBuffer.toString('base64'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: ciphertextBuffer.toString('base64'),
    };
  }

  /**
   * Decrypts payload using RSA-OAEP + AES-256-GCM.
   * 1. Decrypts AES key using RSA Private Key.
   * 2. Decrypts ciphertext using recovered AES key, IV, and Auth Tag.
   */
  public decryptPayload<T = any>(payload: EncryptedPayload, customPrivateKeyPem?: string): T {
    const privKey = customPrivateKeyPem || this.privateKeyPem;

    if (!payload.encryptedKey || !payload.iv || !payload.tag || !payload.ciphertext) {
      throw new Error('Invalid encrypted payload envelope: missing required crypto headers/fields.');
    }

    // 1. Decrypt AES key using RSA Private Key (RSA-OAEP sha256)
    const encryptedKeyBuffer = Buffer.from(payload.encryptedKey, 'base64');
    const aesKey = crypto.privateDecrypt(
      {
        key: privKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      encryptedKeyBuffer
    );

    // 2. Decrypt ciphertext using AES-256-GCM
    const iv = Buffer.from(payload.iv, 'hex');
    const tag = Buffer.from(payload.tag, 'hex');
    const ciphertextBuffer = Buffer.from(payload.ciphertext, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);

    const decryptedBuffer = Buffer.concat([
      decipher.update(ciphertextBuffer),
      decipher.final(),
    ]);

    const decryptedText = decryptedBuffer.toString('utf8');
    try {
      return JSON.parse(decryptedText);
    } catch {
      return decryptedText as unknown as T;
    }
  }

  /**
   * Helper for data at rest encryption. Returns a serialized JSON string.
   */
  public encryptAtRest(data: any): string {
    return JSON.stringify(this.encryptPayload(data));
  }

  /**
   * Helper for data at rest decryption from a serialized JSON string.
   */
  public decryptAtRest<T = any>(serializedEncryptedPayload: string): T {
    const payload: EncryptedPayload = JSON.parse(serializedEncryptedPayload);
    return this.decryptPayload<T>(payload);
  }

  /**
   * Guarantees a 32-byte AES key derived from STORAGE_ENCRYPTION_KEY env
   */
  private getStorageKey(): Buffer {
    const rawKey = this.configService.get<string>('STORAGE_ENCRYPTION_KEY');
    if (!rawKey) {
      throw new Error('[CRYPTO] STORAGE_ENCRYPTION_KEY environment variable is required. Set it in your .env file.');
    }
    return crypto.createHash('sha256').update(rawKey).digest();
  }

  /**
   * Encrypts sensitive string (e.g. phone, resume text, PII) using AES-256-GCM
   */
  public encryptSymmetric(text: string): string {
    if (!text || typeof text !== 'string') return text;
    const key = this.getStorageKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `enc_gcm:${iv.toString('hex')}:${tag}:${encrypted}`;
  }

  /**
   * Decrypts AES-256-GCM encrypted payload back to plaintext. Fallback to raw text if unencrypted legacy row.
   */
  public decryptSymmetric(encryptedString: string): string {
    if (!encryptedString || typeof encryptedString !== 'string' || !encryptedString.startsWith('enc_gcm:')) {
      return encryptedString;
    }
    try {
      const parts = encryptedString.split(':');
      if (parts.length !== 4) return encryptedString;
      const [, ivHex, tagHex, ciphertextHex] = parts;
      const key = this.getStorageKey();
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err: any) {
      this.logger.warn(`Failed to decrypt AES-256-GCM symmetric payload: ${err.message}`);
      return encryptedString;
    }
  }
}
