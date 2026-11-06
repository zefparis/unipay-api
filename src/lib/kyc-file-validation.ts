/**
 * Validation serveur des pièces KYC — basée sur les octets réels,
 * pas sur le type ni l'extension déclarés par le client.
 *
 * Pour chaque fichier : taille min/max, signature magique (PDF %PDF-,
 * JPEG FF D8 FF, PNG 89 50 4E 47), cohérence type réel ↔ MIME déclaré
 * ↔ extension. Utilisée par le chemin multipart ET par le chemin URL
 * signée (octets relus depuis le storage à la confirmation).
 */
import crypto from 'node:crypto';

export const KYC_MIN_FILE_BYTES = 1024;             // 1 Ko
export const KYC_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 Mo

export const KYC_ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

export type KycRealType = 'pdf' | 'jpeg' | 'png';

const REAL_MIME: Record<KycRealType, string> = {
  pdf:  'application/pdf',
  jpeg: 'image/jpeg',
  png:  'image/png',
};

const REAL_EXT: Record<KycRealType, RegExp> = {
  pdf:  /\.pdf$/i,
  jpeg: /\.jpe?g$/i,
  png:  /\.png$/i,
};

/** Détecte le type réel d'un fichier par sa signature magique. */
export function detectKycFileType(buf: Buffer): KycRealType | null {
  if (buf.length >= 5 && buf.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  return null;
}

export interface KycFileInput {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}

/**
 * Valide une pièce KYC. Retourne un message d'erreur (fr) ou null si OK.
 * `label` : nom lisible du document (RCCM, ID NAT, …).
 */
export function validateKycFileBytes(file: KycFileInput, label: string): string | null {
  const size = file.buffer.length;
  if (size < KYC_MIN_FILE_BYTES) {
    return `${label} : le fichier est trop petit (minimum 1 Ko).`;
  }
  if (size > KYC_MAX_FILE_BYTES) {
    return `${label} : le fichier dépasse la taille maximale de 10 Mo.`;
  }

  const real = detectKycFileType(file.buffer);
  if (!real) {
    return `${label} : contenu non reconnu — PDF, JPG ou PNG attendu.`;
  }

  if (!KYC_ALLOWED_MIME.has(file.mimetype)) {
    return `${label} : type de fichier non autorisé (PDF, JPG ou PNG uniquement).`;
  }
  if (file.mimetype !== REAL_MIME[real]) {
    return `${label} : le type déclaré (${file.mimetype}) ne correspond pas au contenu réel (${real.toUpperCase()}).`;
  }
  if (!REAL_EXT[real].test(file.filename)) {
    return `${label} : l'extension du fichier ne correspond pas à son contenu.`;
  }
  return null;
}

/** Nom de fichier réécrit côté serveur : jamais celui du client. */
export function serverFilename(field: string, real: KycRealType): string {
  const ext = real === 'jpeg' ? 'jpg' : real;
  return `${field}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
}
