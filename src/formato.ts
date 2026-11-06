/** Codificação binária compartilhada entre WAL e SSTable. */

const TABELA = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = TABELA[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Valor null representa uma lápide: a chave foi apagada. */
export interface Registro {
  chave: string;
  valor: string | null;
  seq: number;
}

/** Layout: seq(8) | tamanho da chave(4) | tamanho do valor(4, 0xffffffff = lápide) | chave | valor */
export function codificar(r: Registro): Buffer {
  const k = Buffer.from(r.chave);
  const v = r.valor === null ? null : Buffer.from(r.valor);
  const b = Buffer.allocUnsafe(16 + k.length + (v?.length ?? 0));
  b.writeBigUInt64LE(BigInt(r.seq), 0);
  b.writeUInt32LE(k.length, 8);
  b.writeUInt32LE(v === null ? 0xffffffff : v.length, 12);
  k.copy(b, 16);
  v?.copy(b, 16 + k.length);
  return b;
}

export function decodificar(b: Buffer, o: number): { registro: Registro; proximo: number } {
  const seq = Number(b.readBigUInt64LE(o));
  const tk = b.readUInt32LE(o + 8);
  const tv = b.readUInt32LE(o + 12);
  const chave = b.toString("utf8", o + 16, o + 16 + tk);
  if (tv === 0xffffffff) return { registro: { chave, valor: null, seq }, proximo: o + 16 + tk };
  const fim = o + 16 + tk + tv;
  return { registro: { chave, valor: b.toString("utf8", o + 16 + tk, fim), seq }, proximo: fim };
}

/** Filtro de Bloom com dupla função de hash, cerca de 10 bits por chave (~1% de falso positivo). */
export class Bloom {
  readonly bits: Uint8Array;
  readonly k: number;

  constructor(bits: Uint8Array, k = 7) {
    this.bits = bits;
    this.k = k;
  }

  static para(n: number): Bloom {
    return new Bloom(new Uint8Array(Math.max(8, Math.ceil((n * 10) / 8))));
  }

  private hashes(chave: string): [number, number] {
    let a = 0x811c9dc5;
    let b = 0x9747b28c;
    for (let i = 0; i < chave.length; i++) {
      const c = chave.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995);
      b ^= b >>> 15;
    }
    return [a >>> 0, (b | 1) >>> 0];
  }

  adicionar(chave: string): void {
    const [a, b] = this.hashes(chave);
    const total = this.bits.length * 8;
    for (let i = 0; i < this.k; i++) {
      const p = (a + Math.imul(i, b)) >>> 0;
      this.bits[(p % total) >> 3]! |= 1 << (p % total & 7);
    }
  }

  talvez(chave: string): boolean {
    const [a, b] = this.hashes(chave);
    const total = this.bits.length * 8;
    for (let i = 0; i < this.k; i++) {
      const p = (a + Math.imul(i, b)) >>> 0;
      if (!(this.bits[(p % total) >> 3]! & (1 << (p % total & 7)))) return false;
    }
    return true;
  }
}
