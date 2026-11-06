/**
 * Motor LSM: WAL, memtable, SSTables, manifesto e compactação por camadas de tamanho.
 *
 * Ordem de durabilidade em um flush:
 *   1. grava a nova tabela em arquivo temporário, com fsync, e renomeia
 *   2. grava o manifesto novo do mesmo jeito (é este passo que publica a tabela)
 *   3. só então descarta o WAL antigo
 * Uma queda entre quaisquer passos deixa o estado anterior íntegro, e um arquivo
 * órfão é removido na abertura.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { codificar, crc32, decodificar, type Registro } from "./formato.ts";
import { Tabela, escreverTabela } from "./sstable.ts";

export interface Opcoes {
  limiteMemtable?: number;
  gatilhoCompactacao?: number;
  /** false troca durabilidade por vazão: fsync só no flush. */
  sincronizar?: boolean;
}

export interface Metricas {
  bytesUsuario: number;
  bytesGravados: number;
  flushes: number;
  compactacoes: number;
  recuperados: number;
  descartadosNaCauda: number;
}

interface Manifesto {
  proximoArquivo: number;
  tabelas: string[]; // da mais nova para a mais antiga
  walAtual: number;
}

export class Motor {
  private readonly pasta: string;
  private readonly limite: number;
  private readonly gatilho: number;
  private readonly sincronizar: boolean;
  private memtable = new Map<string, Registro>();
  private tamanhoMem = 0;
  private tabelas: Tabela[] = [];
  private manifesto: Manifesto = { proximoArquivo: 1, tabelas: [], walAtual: 0 };
  private wal = -1;
  private seq = 0;
  private fechado = false;
  readonly metricas: Metricas = { bytesUsuario: 0, bytesGravados: 0, flushes: 0, compactacoes: 0, recuperados: 0, descartadosNaCauda: 0 };

  constructor(pasta: string, opcoes: Opcoes = {}) {
    this.pasta = pasta;
    this.limite = opcoes.limiteMemtable ?? 1 << 20;
    this.gatilho = opcoes.gatilhoCompactacao ?? 4;
    this.sincronizar = opcoes.sincronizar ?? true;
    mkdirSync(pasta, { recursive: true });
    this.abrir();
  }

  private caminho(nome: string): string {
    return join(this.pasta, nome);
  }

  private nomeWal(n: number): string {
    return `wal-${n}.log`;
  }

  private abrir(): void {
    const m = this.caminho("MANIFESTO");
    if (existsSync(m)) this.manifesto = JSON.parse(readFileSync(m, "utf8"));
    this.tabelas = this.manifesto.tabelas.map((t) => new Tabela(this.caminho(t)));
    for (const t of this.tabelas) for (const r of t.varrer()) this.seq = Math.max(this.seq, r.seq);

    // Remove o que uma queda deixou para trás: nada aqui foi publicado pelo manifesto.
    const vivos = new Set(["MANIFESTO", ...this.manifesto.tabelas, this.nomeWal(this.manifesto.walAtual)]);
    for (const f of readdirSync(this.pasta)) if (!vivos.has(f)) rmSync(this.caminho(f), { force: true });

    this.recuperarWal();
    this.wal = openSync(this.caminho(this.nomeWal(this.manifesto.walAtual)), "a");
  }

  /**
   * Cada entrada do WAL é: tamanho(4) | crc(4) | registro. A cauda pode estar
   * incompleta depois de uma queda: é uma escrita que nunca foi confirmada,
   * então a leitura para ali e trunca o arquivo.
   */
  private recuperarWal(): void {
    const c = this.caminho(this.nomeWal(this.manifesto.walAtual));
    if (!existsSync(c)) return;
    const b = readFileSync(c);
    let o = 0;
    while (o + 8 <= b.length) {
      const t = b.readUInt32LE(o);
      if (o + 8 + t > b.length) break;
      const corpo = b.subarray(o + 8, o + 8 + t);
      if (crc32(corpo) !== b.readUInt32LE(o + 4)) break;
      const { registro } = decodificar(corpo, 0);
      this.porNaMemtable(registro);
      this.seq = Math.max(this.seq, registro.seq);
      this.metricas.recuperados++;
      o += 8 + t;
    }
    if (o < b.length) {
      this.metricas.descartadosNaCauda = b.length - o;
      writeFileSync(c, b.subarray(0, o)); // sem isso, novas escritas ficariam depois do lixo e se perderiam
    }
  }

  private porNaMemtable(r: Registro): void {
    this.memtable.set(r.chave, r);
    this.tamanhoMem += r.chave.length + (r.valor?.length ?? 0) + 32;
  }

  private gravar(chave: string, valor: string | null): void {
    if (this.fechado) throw new Error("Motor fechado");
    const r: Registro = { chave, valor, seq: ++this.seq };
    const corpo = codificar(r);
    const c = Buffer.allocUnsafe(8 + corpo.length);
    c.writeUInt32LE(corpo.length, 0);
    c.writeUInt32LE(crc32(corpo), 4);
    corpo.copy(c, 8);
    writeSync(this.wal, c);
    if (this.sincronizar) fsyncSync(this.wal);
    this.metricas.bytesUsuario += chave.length + (valor?.length ?? 0);
    this.metricas.bytesGravados += c.length;
    this.porNaMemtable(r);
    if (this.tamanhoMem >= this.limite) this.flush();
  }

  colocar(chave: string, valor: string): void {
    this.gravar(chave, valor);
  }

  apagar(chave: string): void {
    this.gravar(chave, null);
  }

  obter(chave: string): string | undefined {
    const m = this.memtable.get(chave);
    if (m) return m.valor ?? undefined;
    for (const t of this.tabelas) {
      const r = t.buscar(chave);
      if (r) return r.valor ?? undefined;
    }
    return undefined;
  }

  /** Une várias fontes ordenadas; em chave repetida, vale a de maior seq. */
  private *intercalar(fontes: Iterator<Registro>[]): Generator<Registro> {
    const topos = fontes.map((f) => f.next());
    for (;;) {
      let menor: string | null = null;
      for (const t of topos) if (!t.done && (menor === null || t.value.chave < menor)) menor = t.value.chave;
      if (menor === null) return;
      let vencedor: Registro | null = null;
      for (let i = 0; i < topos.length; i++) {
        const t = topos[i]!;
        if (!t.done && t.value.chave === menor) {
          if (!vencedor || t.value.seq > vencedor.seq) vencedor = t.value;
          topos[i] = fontes[i]!.next();
        }
      }
      yield vencedor!;
    }
  }

  /** Faixa ordenada, sem lápides. */
  *faixa(inicio = "", fim = "￿"): Generator<[string, string]> {
    const mem = [...this.memtable.values()].sort((a, b) => (a.chave < b.chave ? -1 : 1));
    const fontes = [mem[Symbol.iterator](), ...this.tabelas.map((t) => t.varrer())];
    for (const r of this.intercalar(fontes)) {
      if (r.chave < inicio) continue;
      if (r.chave >= fim) return;
      if (r.valor !== null) yield [r.chave, r.valor];
    }
  }

  private publicar(): void {
    const tmp = this.caminho("MANIFESTO.tmp");
    const fd = openSync(tmp, "w");
    writeSync(fd, JSON.stringify(this.manifesto));
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.caminho("MANIFESTO"));
  }

  flush(): void {
    if (this.memtable.size === 0) return;
    const nome = `t-${this.manifesto.proximoArquivo++}.sst`;
    const ordenados = [...this.memtable.values()].sort((a, b) => (a.chave < b.chave ? -1 : 1));
    this.pontoDeFalha("antes-da-tabela");
    escreverTabela(this.caminho(nome), ordenados, ordenados.length);
    this.pontoDeFalha("depois-da-tabela");
    const tabela = new Tabela(this.caminho(nome));
    this.metricas.bytesGravados += tabela.tamanhoArquivo;
    const walVelho = this.manifesto.walAtual;
    this.manifesto.walAtual = this.manifesto.proximoArquivo++;
    this.manifesto.tabelas.unshift(nome);
    this.publicar();
    this.pontoDeFalha("depois-do-manifesto");
    this.tabelas.unshift(tabela);
    closeSync(this.wal);
    this.wal = openSync(this.caminho(this.nomeWal(this.manifesto.walAtual)), "a");
    rmSync(this.caminho(this.nomeWal(walVelho)), { force: true });
    this.memtable.clear();
    this.tamanhoMem = 0;
    this.metricas.flushes++;
    if (this.tabelas.length >= this.gatilho) this.compactar();
  }

  /** Une todas as tabelas em uma. Como não sobra nada mais antigo, as lápides podem sumir. */
  compactar(): void {
    if (this.tabelas.length < 2) return;
    const nome = `t-${this.manifesto.proximoArquivo++}.sst`;
    const total = this.tabelas.reduce((t, x) => t + x.contagem, 0);
    function* semLapides(g: Generator<Registro>) {
      for (const r of g) if (r.valor !== null) yield r;
    }
    escreverTabela(this.caminho(nome), semLapides(this.intercalar(this.tabelas.map((t) => t.varrer()))), total);
    this.pontoDeFalha("compactacao-depois-da-tabela");
    const nova = new Tabela(this.caminho(nome));
    this.metricas.bytesGravados += nova.tamanhoArquivo;
    const velhas = this.tabelas;
    this.manifesto.tabelas = [nome];
    this.publicar();
    this.pontoDeFalha("compactacao-depois-do-manifesto");
    this.tabelas = [nova];
    for (const t of velhas) {
      t.fechar();
      rmSync(t.caminho, { force: true });
    }
    this.metricas.compactacoes++;
  }

  /** Gancho para os testes simularem queda em um ponto exato. */
  pontoDeFalha: (nome: string) => void = () => {};

  estatisticas() {
    return {
      tabelas: this.tabelas.length,
      leiturasDeBloco: this.tabelas.reduce((t, x) => t + x.leiturasDeBloco, 0),
      evitadasPorBloom: this.tabelas.reduce((t, x) => t + x.evitadasPorBloom, 0),
      amplificacaoEscrita: this.metricas.bytesUsuario ? this.metricas.bytesGravados / this.metricas.bytesUsuario : 0,
    };
  }

  /** Solta os arquivos sem flush, como uma queda de processo faria. */
  abandonar(): void {
    this.fechado = true;
    closeSync(this.wal);
    for (const t of this.tabelas) t.fechar();
  }

  fechar(): void {
    this.flush();
    this.abandonar();
  }
}
