import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKycFileType, validateKycFileBytes, serverFilename,
  KYC_MIN_FILE_BYTES, KYC_MAX_FILE_BYTES,
} from '../kyc-file-validation';

const buf = (head: number[] | string, size: number) => {
  const b = Buffer.alloc(Math.max(size, 1), 0x41);
  const h = Buffer.from(head as never);
  h.copy(b, 0);
  return b;
};
const PDF = '%PDF-';
const JPG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('detectKycFileType — signatures magiques', () => {
  it('détecte PDF / JPEG / PNG', () => {
    assert.equal(detectKycFileType(buf(PDF, 2048)), 'pdf');
    assert.equal(detectKycFileType(buf(JPG, 2048)), 'jpeg');
    assert.equal(detectKycFileType(buf(PNG, 2048)), 'png');
  });
  it('rejette le contenu arbitraire', () => {
    assert.equal(detectKycFileType(buf('<!DOCTYPE html>', 2048)), null);
    assert.equal(detectKycFileType(buf('MZ', 2048)), null);
    assert.equal(detectKycFileType(Buffer.alloc(3)), null);
  });
});

describe('validateKycFileBytes — fichiers piégés (cas prod)', () => {
  it('REFUSE evil.pdf 13 octets déclaré PDF', () => {
    assert.match(
      validateKycFileBytes({ buffer: buf('hello world', 13), filename: 'evil.pdf', mimetype: 'application/pdf' }, 'RCCM')!,
      /trop petit|non reconnu/,
    );
  });
  it('REFUSE un HTML de 2 Ko déclaré PDF', () => {
    assert.match(
      validateKycFileBytes({ buffer: buf('<html><script>alert(1)</script></html>', 2048), filename: 'doc.pdf', mimetype: 'application/pdf' }, 'RCCM')!,
      /non reconnu/,
    );
  });
  it('REFUSE un PNG déclaré PDF (type réel ≠ déclaré)', () => {
    assert.match(
      validateKycFileBytes({ buffer: buf(PNG, 2048), filename: 'doc.pdf', mimetype: 'application/pdf' }, 'RCCM')!,
      /ne correspond pas au contenu réel/,
    );
  });
  it('REFUSE un vrai PDF nommé .jpg (extension ≠ contenu)', () => {
    assert.match(
      validateKycFileBytes({ buffer: buf(PDF, 2048), filename: 'doc.jpg', mimetype: 'application/pdf' }, 'RCCM')!,
      /extension.*ne correspond pas/,
    );
  });
  it('REFUSE un vrai PDF de 500 octets (min 1 Ko)', () => {
    assert.match(
      validateKycFileBytes({ buffer: buf(PDF, 500), filename: 'doc.pdf', mimetype: 'application/pdf' }, 'RCCM')!,
      /trop petit/,
    );
  });
  it('REFUSE un PDF > 10 Mo', () => {
    const big = Buffer.alloc(KYC_MAX_FILE_BYTES + 1, 0x41);
    Buffer.from('%PDF-').copy(big, 0);
    assert.match(
      validateKycFileBytes({ buffer: big, filename: 'doc.pdf', mimetype: 'application/pdf' }, 'RCCM')!,
      /taille maximale/,
    );
  });
  it('ACCEPTE un vrai PDF 2 Ko déclaré PDF .pdf', () => {
    assert.equal(
      validateKycFileBytes({ buffer: buf(PDF, 2048), filename: 'doc.pdf', mimetype: 'application/pdf' }, 'RCCM'),
      null,
    );
  });
  it('ACCEPTE JPEG et PNG cohérents', () => {
    assert.equal(validateKycFileBytes({ buffer: buf(JPG, 2048), filename: 'p.jpeg', mimetype: 'image/jpeg' }, 'RCCM'), null);
    assert.equal(validateKycFileBytes({ buffer: buf(PNG, 2048), filename: 'p.png', mimetype: 'image/png' }, 'RCCM'), null);
  });
  it('bornes exposées : min 1 Ko / max 10 Mo', () => {
    assert.equal(KYC_MIN_FILE_BYTES, 1024);
    assert.equal(KYC_MAX_FILE_BYTES, 10 * 1024 * 1024);
  });
});

describe('serverFilename — nom réécrit côté serveur', () => {
  it('n\u2019utilise jamais le nom client et force l\u2019extension réelle', () => {
    const f = serverFilename('rccm', 'jpeg');
    assert.match(f, /^rccm-\d+-[0-9a-f]{8}\.jpg$/);
    assert.ok(!f.includes('evil'));
  });
});
