// Mede o motor. Os números do README saem daqui.
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { Motor } from "../src/motor.ts";

const VALOR = "x".repeat(100);
const chave = (i: number) => `usuario:${String((i * 2654435761) % 4294967296).padStart(10, "0")}`;
const ops = (n: number, ms: number) => Math.round((n / ms) * 1000).toLocaleString("pt-BR");

function medir<T>(f: () => T): [T, number] {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
}

function rodada(gatilho: number, n: number) {
  const p = mkdtempSync(join(tmpdir(), "bench-"));
  const m = new Motor(p, { sincronizar: false, gatilhoCompactacao: gatilho, limiteMemtable: 1 << 20 });
  const [, escrita] = medir(() => {
    for (let i = 0; i < n; i++) m.colocar(chave(i), VALOR);
  });
  m.flush();
  const e = m.estatisticas();
  const leituras = 50_000;
  const [, acerto] = medir(() => {
    for (let i = 0; i < leituras; i++) m.obter(chave((i * 7) % n));
  });
  const blocosAcerto = m.estatisticas().leiturasDeBloco;
  const [, erro] = medir(() => {
    for (let i = 0; i < leituras; i++) m.obter(`ausente:${i}`);
  });
  const fim = m.estatisticas();
  console.log(`gatilho ${gatilho}: escrita ${ops(n, escrita)} ops/s | amplificação ${e.amplificacaoEscrita.toFixed(2)}x | tabelas ${e.tabelas} | compactações ${m.metricas.compactacoes} | leitura presente ${ops(leituras, acerto)} ops/s (${(blocosAcerto / leituras).toFixed(2)} blocos/leitura) | leitura ausente ${ops(leituras, erro)} ops/s (${((fim.leiturasDeBloco - blocosAcerto) / leituras).toFixed(3)} blocos/leitura)`);
  m.fechar();
  rmSync(p, { recursive: true, force: true });
}

console.log(`Node ${process.version}, ${cpus()[0]?.model}, ${process.platform}`);
rodada(4, 300_000);
rodada(8, 300_000);
rodada(16, 300_000);

const p = mkdtempSync(join(tmpdir(), "bench-"));
const m = new Motor(p, { sincronizar: true });
const n = 2000;
const [, duravel] = medir(() => {
  for (let i = 0; i < n; i++) m.colocar(chave(i), VALOR);
});
console.log(`com fsync por escrita: ${ops(n, duravel)} ops/s`);
m.fechar();
rmSync(p, { recursive: true, force: true });
