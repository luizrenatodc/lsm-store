/**
 * Arquivo imutável e ordenado.
 *
 * Layout: blocos de dados | índice esparso | filtro de Bloom | rodapé
 * O rodapé tem tamanho fixo e fica no final. Cada bloco e cada seção de metadados
 * carregam CRC, então corrupção vira erro explícito em vez de dado errado.
 */
import { closeSync, fsyncSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { Bloom, codificar, crc32, decodificar, type Registro } from "./formato.ts";

const MAGICO = 0x4c534d31;
const RODAPE = 40;
const BLOCO = 4096;

export class ErroCorrupcao extends Error {}

interface EntradaIndice {
  primeira: string;
  posicao: number;
  tamanho: number;
}

export function escreverTabela(caminho: string, registros: Iterable<Registro>, estimativa: number): void {
  const tmp = `${caminho}.tmp`;
  const fd = openSync(tmp, "w");
  const bloom = Bloom.para(Math.max(1, estimativa));
  const indice: EntradaIndice[] = [];
  let posicao = 0;
  let partes: Buffer[] = [];
  let tamanho = 0;
  let primeira: string | null = null;

  const fechar = () => {
    if (primeira === null) return;
    const dados = Buffer.concat(partes);
    const crc = Buffer.allocUnsafe(4);
    crc.writeUInt32LE(crc32(dados));
    writeSync(fd, dados);
    writeSync(fd, crc);
    indice.push({ primeira, posicao, tamanho: dados.length });
    posicao += dados.length + 4;
    partes = [];
    tamanho = 0;
    primeira = null;
  };

  let contagem = 0;
  for (const r of registros) {
    const b = codificar(r);
    primeira ??= r.chave;
    partes.push(b);
    tamanho += b.length;
    bloom.adicionar(r.chave);
    contagem++;
    if (tamanho >= BLOCO) fechar();
  }
  fechar();

  const indiceBytes = Buffer.from(JSON.stringify(indice));
  const bloomBytes = Buffer.from(bloom.bits);
  writeSync(fd, indiceBytes);
  writeSync(fd, bloomBytes);
  const r = Buffer.alloc(RODAPE);
  r.writeUInt32LE(MAGICO, 0);
  r.writeBigUInt64LE(BigInt(posicao), 4);
  r.writeUInt32LE(indiceBytes.length, 12);
  r.writeUInt32LE(bloomBytes.length, 16);
  r.writeUInt32LE(crc32(indiceBytes), 20);
  r.writeUInt32LE(crc32(bloomBytes), 24);
  r.writeUInt32LE(contagem, 28);
  r.writeUInt32LE(crc32(r.subarray(0, 36)), 36);
  writeSync(fd, r);
  fsyncSync(fd);
  closeSync(fd);
  // Renomear é atômico: leitores só veem o arquivo completo.
  renameSync(tmp, caminho);
}

export class Tabela {
  readonly caminho: string;
  readonly contagem: number;
  readonly tamanhoArquivo: number;
  private readonly fd: number;
  private readonly indice: EntradaIndice[];
  private readonly bloom: Bloom;
  leiturasDeBloco = 0;
  evitadasPorBloom = 0;

  constructor(caminho: string) {
    this.caminho = caminho;
    this.fd = openSync(caminho, "r");
    this.tamanhoArquivo = statSync(caminho).size;
    const r = this.ler(this.tamanhoArquivo - RODAPE, RODAPE);
    if (r.readUInt32LE(0) !== MAGICO || r.readUInt32LE(36) !== crc32(r.subarray(0, 36))) throw new ErroCorrupcao(`Rodapé inválido em ${caminho}`);
    const inicio = Number(r.readBigUInt64LE(4));
    const ti = r.readUInt32LE(12);
    const tb = r.readUInt32LE(16);
    const bi = this.ler(inicio, ti);
    const bb = this.ler(inicio + ti, tb);
    if (crc32(bi) !== r.readUInt32LE(20) || crc32(bb) !== r.readUInt32LE(24)) throw new ErroCorrupcao(`Metadados inválidos em ${caminho}`);
    this.indice = JSON.parse(bi.toString());
    this.bloom = new Bloom(new Uint8Array(bb));
    this.contagem = r.readUInt32LE(28);
  }

  private ler(posicao: number, tamanho: number): Buffer {
    const b = Buffer.allocUnsafe(tamanho);
    readSync(this.fd, b, 0, tamanho, posicao);
    return b;
  }

  private bloco(i: number): Registro[] {
    const e = this.indice[i]!;
    this.leiturasDeBloco++;
    const b = this.ler(e.posicao, e.tamanho + 4);
    const dados = b.subarray(0, e.tamanho);
    if (crc32(dados) !== b.readUInt32LE(e.tamanho)) throw new ErroCorrupcao(`Bloco ${i} corrompido em ${this.caminho}`);
    const saida: Registro[] = [];
    let o = 0;
    while (o < dados.length) {
      const d = decodificar(dados, o);
      saida.push(d.registro);
      o = d.proximo;
    }
    return saida;
  }

  /** undefined = não está aqui. null = lápide, a chave foi apagada. */
  buscar(chave: string): Registro | undefined {
    if (!this.bloom.talvez(chave)) {
      this.evitadasPorBloom++;
      return undefined;
    }
    let a = 0;
    let z = this.indice.length - 1;
    let alvo = -1;
    while (a <= z) {
      const m = (a + z) >> 1;
      if (this.indice[m]!.primeira <= chave) {
        alvo = m;
        a = m + 1;
      } else z = m - 1;
    }
    if (alvo < 0) return undefined;
    return this.bloco(alvo).find((r) => r.chave === chave);
  }

  *varrer(): Generator<Registro> {
    for (let i = 0; i < this.indice.length; i++) yield* this.bloco(i);
  }

  fechar(): void {
    closeSync(this.fd);
  }
}
