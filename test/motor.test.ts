import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bloom } from "../src/formato.ts";
import { Motor } from "../src/motor.ts";
import { ErroCorrupcao, Tabela, escreverTabela } from "../src/sstable.ts";

const pastas: string[] = [];
function pasta(): string {
  const p = mkdtempSync(join(tmpdir(), "lsm-"));
  pastas.push(p);
  return p;
}
test.after(() => {
  for (const p of pastas) rmSync(p, { recursive: true, force: true });
});

function prng(s: number): () => number {
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rapido = { limiteMemtable: 2048, sincronizar: false };

test("grava, lê, sobrescreve e apaga", () => {
  const m = new Motor(pasta(), rapido);
  m.colocar("a", "1");
  m.colocar("a", "2");
  m.colocar("b", "3");
  m.apagar("b");
  assert.equal(m.obter("a"), "2");
  assert.equal(m.obter("b"), undefined);
  assert.equal(m.obter("c"), undefined);
  m.fechar();
});

test("lápide em tabela nova esconde valor em tabela antiga", () => {
  const m = new Motor(pasta(), { ...rapido, gatilhoCompactacao: 99 });
  m.colocar("x", "velho");
  m.flush();
  m.apagar("x");
  m.flush();
  assert.equal(m.estatisticas().tabelas, 2);
  assert.equal(m.obter("x"), undefined);
  assert.deepEqual([...m.faixa()], []);
  m.fechar();
});

test("modelo: 40 mil operações aleatórias batem com um Map, atravessando reaberturas", () => {
  const p = pasta();
  const r = prng(42);
  const modelo = new Map<string, string>();
  let m = new Motor(p, rapido);
  for (let i = 0; i < 40_000; i++) {
    const chave = `k${Math.floor(r() * 800)}`;
    const sorte = r();
    if (sorte < 0.55) {
      const valor = `v${i}-${"x".repeat(Math.floor(r() * 40))}`;
      m.colocar(chave, valor);
      modelo.set(chave, valor);
    } else if (sorte < 0.75) {
      m.apagar(chave);
      modelo.delete(chave);
    } else assert.equal(m.obter(chave), modelo.get(chave), `op ${i}`);
    if (i % 7001 === 7000) {
      m.fechar();
      m = new Motor(p, rapido);
    }
  }
  const esperado = [...modelo].sort(([a], [b]) => (a < b ? -1 : 1));
  assert.deepEqual([...m.faixa()], esperado);
  m.fechar();
});

test("faixa respeita os limites", () => {
  const m = new Motor(pasta(), rapido);
  for (const k of ["a", "b", "c", "d"]) m.colocar(k, k);
  m.flush();
  m.colocar("b", "novo");
  assert.deepEqual([...m.faixa("b", "d")], [["b", "novo"], ["c", "c"]]);
  m.fechar();
});

test("queda sem flush: WAL devolve tudo o que foi confirmado", () => {
  const p = pasta();
  const m = new Motor(p, { limiteMemtable: 1 << 20 });
  for (let i = 0; i < 50; i++) m.colocar(`k${i}`, `v${i}`);
  m.apagar("k7");
  m.abandonar();
  const n = new Motor(p);
  assert.equal(n.metricas.recuperados, 51);
  assert.equal(n.obter("k49"), "v49");
  assert.equal(n.obter("k7"), undefined);
  n.fechar();
});

test("WAL cortado em CADA byte possível recupera exatamente um prefixo das escritas", () => {
  const p = pasta();
  const m = new Motor(p, { limiteMemtable: 1 << 20 });
  const n = 40;
  for (let i = 0; i < n; i++) m.colocar(`chave-${i}`, `valor-${i}`);
  m.abandonar();
  const wal = readdirSync(p).find((f) => f.startsWith("wal-"))!;
  const tamanho = statSync(join(p, wal)).size;
  const copia = pasta();
  let anterior = 0;
  for (let corte = 0; corte <= tamanho; corte++) {
    rmSync(copia, { recursive: true, force: true });
    mkdirSync(copia);
    copyFileSync(join(p, wal), join(copia, wal));
    truncateSync(join(copia, wal), corte);
    const r = new Motor(copia, { limiteMemtable: 1 << 20, sincronizar: false });
    const recuperados = r.metricas.recuperados;
    assert.ok(recuperados >= anterior, "cortar menos nunca recupera menos");
    anterior = recuperados;
    for (let i = 0; i < n; i++) assert.equal(r.obter(`chave-${i}`), i < recuperados ? `valor-${i}` : undefined, `corte ${corte}, chave ${i}`);
    // Escrever depois da recuperação precisa funcionar: a cauda ruim foi truncada.
    r.colocar("depois", "ok");
    r.abandonar();
    const r2 = new Motor(copia, { limiteMemtable: 1 << 20, sincronizar: false });
    assert.equal(r2.obter("depois"), "ok", `corte ${corte}`);
    r2.abandonar();
  }
  assert.equal(anterior, n);
});

test("byte trocado no meio do WAL interrompe a recuperação ali, sem dado errado", () => {
  const p = pasta();
  const m = new Motor(p, { limiteMemtable: 1 << 20 });
  for (let i = 0; i < 20; i++) m.colocar(`k${i}`, `v${i}`);
  m.abandonar();
  const wal = join(p, readdirSync(p).find((f) => f.startsWith("wal-"))!);
  const b = readFileSync(wal);
  b[Math.floor(b.length / 2)]! ^= 0xff;
  writeFileSync(wal, b);
  const r = new Motor(p);
  assert.ok(r.metricas.recuperados > 0 && r.metricas.recuperados < 20);
  for (const [k, v] of r.faixa()) assert.equal(v, k.replace("k", "v"));
  r.abandonar();
});

for (const ponto of ["antes-da-tabela", "depois-da-tabela", "depois-do-manifesto", "compactacao-depois-da-tabela", "compactacao-depois-do-manifesto"]) {
  test(`queda em ${ponto} não perde nem ressuscita dados`, () => {
    const p = pasta();
    const m = new Motor(p, { limiteMemtable: 1 << 30, gatilhoCompactacao: 2 });
    m.colocar("mantida", "1");
    m.colocar("apagada", "x");
    m.flush();
    m.apagar("apagada");
    m.colocar("nova", "2");
    m.pontoDeFalha = (n) => {
      if (n === ponto) throw new Error("queda");
    };
    assert.throws(() => m.flush(), /queda/);
    m.abandonar();
    const r = new Motor(p);
    assert.equal(r.obter("mantida"), "1");
    assert.equal(r.obter("apagada"), undefined, "lápide não pode se perder");
    assert.equal(r.obter("nova"), "2");
    assert.equal(readdirSync(p).filter((f) => f.endsWith(".tmp")).length, 0);
    r.fechar();
  });
}

test("compactação remove lápides e versões antigas", () => {
  const p = pasta();
  const m = new Motor(p, { ...rapido, gatilhoCompactacao: 99 });
  for (let v = 0; v < 5; v++) {
    for (let i = 0; i < 100; i++) m.colocar(`k${i}`, `v${v}`);
    m.flush();
  }
  for (let i = 0; i < 50; i++) m.apagar(`k${i}`);
  m.flush();
  m.compactar();
  assert.equal(m.estatisticas().tabelas, 1);
  assert.equal([...m.faixa()].length, 50);
  const nome = readdirSync(p).find((f) => f.endsWith(".sst"))!;
  m.fechar();
  assert.ok(new Tabela(join(p, nome)).contagem <= 50);
});

test("bloco corrompido vira erro explícito", () => {
  const c = join(pasta(), "t.sst");
  escreverTabela(c, [{ chave: "a", valor: "1", seq: 1 }], 1);
  const b = readFileSync(c);
  b[18]! ^= 0xff;
  writeFileSync(c, b);
  assert.throws(() => new Tabela(c).buscar("a"), ErroCorrupcao);
});

test("Bloom não tem falso negativo e fica perto de 1% de falso positivo", () => {
  const b = Bloom.para(10_000);
  for (let i = 0; i < 10_000; i++) b.adicionar(`presente-${i}`);
  for (let i = 0; i < 10_000; i++) assert.ok(b.talvez(`presente-${i}`));
  let falsos = 0;
  for (let i = 0; i < 10_000; i++) if (b.talvez(`ausente-${i}`)) falsos++;
  assert.ok(falsos < 300, `falsos positivos: ${falsos}`);
});
