# Fluxo de Caixa — Histórico e Contexto

> Documento de referência pra nunca perder o contexto das decisões tomadas na tela de **Fluxo de Caixa**. Atualize este arquivo sempre que uma regra de negócio mudar.

## Onde fica cada coisa

| Camada | Arquivo |
|---|---|
| Tela (frontend) | `app/fluxo-caixa/page.tsx` |
| Proxy Next.js → backend | `app/api/fluxo-caixa/**/route.ts` |
| Lógica/SQL (backend) | `python-backend/routers/fluxo_caixa.py` |
| Banco | PostgreSQL remoto em `dbexp.vcenter.com.br`, usuário `liebe_ro` (apesar do nome, **não é somente leitura** — faz CREATE TABLE/INSERT/DELETE nas tabelas `fcp_*`) |

Essa tela foi **portada 1:1 do app `app_controladoria`** (`~/Desenvolvimento/app_controladoria`, Node/Express mais antigo, ainda em produção, mesmo banco). Se um dia parecer que "isso já existe em algum lugar", provavelmente é lá.

## Origem das colunas

| Coluna | Origem dos dados | Aparece na tela hoje? |
|---|---|---|
| Previsão / Real (Saídas) | Duplicatas a pagar | Sim |
| Pedidos | Pedidos de compra (`vr_cmp_pedidoc2`) | Sim |
| Cartão | Cartão de crédito | **Não** — removida a pedido do usuário (dados continuam vindo da API, só não são exibidos nem compõem saldo) |
| Boleto | Faturas a receber tipo boleto (`vr_fcr_faturai`) | Sim |
| Cheque | Faturas a receber tipo cheque (`vr_fcr_faturai`) | Sim |
| Lojas | Projeção manual colada pelo usuário (`fcp_lojas_projecao`) | Sim |
| Outras Entradas | Projeção manual colada pelo usuário (`fcp_outras_entradas_projecao`) | Sim |
| Multimarcas | — | **Não** — removida junto com Cartão, mesmo motivo |

**Saldo bancário real** (`Saldos Bancários`, tabela separada no topo) vem de `fin_disponibilidade_caixa`/`fin_contas_bancarias` e é o ponto de partida do saldo acumulado diário.

## Regras de deslocamento de data (o "coração" da tela)

Cada tipo de entrada/saída tem uma data original (vencimento) que **nunca é alterada no banco** — só a "data efetiva" usada pra agrupar no fluxo de caixa é deslocada, conforme a tabela abaixo. Toda a lógica mora em `_expr_dt_efetiva()` e nas funções SQL específicas em `fluxo_caixa.py`.

| Coluna | Regra | Observação |
|---|---|---|
| **Boleto** | Seg–Qui → D+1 · Sexta → segunda seguinte · Sáb/Dom → terça seguinte · **se cair em feriado bancário, avança pro próximo dia útil** (cadeia: pode pular mais de um feriado seguido, ex. Carnaval) | Implementada em `fn_fc_dt_boleto_efetiva()` + `fn_fc_proximo_dia_util_bancario()`, únicas colunas com awareness de feriado. Feriados cadastrados automaticamente de 2025 a 2033 em `fcp_feriados_bancarios` (fixos + móveis calculados via Páscoa de Gauss) |
| **Pedidos** | Sáb/Dom → segunda seguinte | Mesma regra das Saídas (regra 2), sem D+1 em dia útil e sem checagem de feriado |
| **Saídas (duplicatas)** | Sáb/Dom → segunda seguinte | Regra 2 |
| **Lojas** | Sáb/Dom → terça seguinte | Regra 3, sem D+1 e sem feriado |
| **Outras Entradas** | Sáb/Dom → terça seguinte | Regra 3, igual Lojas |
| **Cheque** | **Nenhum deslocamento** — usa `dt_vencimento` cru | Nunca foi pedido ajuste pra essa coluna; é a única coluna visível que ainda pode ter valor num sábado/domingo |

**Importante:** as linhas de sábado/domingo **continuam aparecendo** na tabela Visão Diária (com rótulo SAB/DOM) — elas não são removidas. O que acontece é que a maioria das colunas fica zerada nesses dias porque o valor foi deslocado pra um dia útil. Só Cheque pode mostrar valor num fim de semana.

Também existe a **regra 1**, comum a quase todas as colunas: só entra no fluxo o que tem data efetiva **estritamente futura** (`> CURRENT_DATE`) — nada de histórico/vencido aparece como "a receber/pagar" projetado.

## Feriados bancários (`fcp_feriados_bancarios`)

Tabela própria, auto-seedada em `_seed_feriados_bancarios()` (chamada toda vez que `_criar_tabelas_fluxo_caixa()` roda, idempotente via `ON CONFLICT DO NOTHING`). Inclui os feriados nacionais que afetam compensação bancária:

- Fixos: Confraternização Universal (1/1), Tiradentes (21/4), Dia do Trabalho (1/5), Independência (7/9), Nossa Senhora Aparecida (12/10), Finados (2/11), Proclamação da República (15/11), Consciência Negra (20/11, nacional desde a Lei 14.759/2023), Natal (25/12).
- Móveis (calculados a partir da Páscoa, algoritmo de Gauss): Carnaval (segunda e terça), Sexta-feira Santa, Corpus Christi.
- Cobertura: ano atual − 1 até ano atual + 6 (recalculado toda vez, então nunca fica "sem feriado cadastrado" pra frente).

Só feriados **nacionais** — não há feriados estaduais/municipais nem pontos facultativos.

## Tabelas manuais de projeção (colar da planilha)

Três mecanismos iguais no padrão (textarea → parse `DD/MM/AAAA;valor` ou tab → POST em lote de 500 linhas → dedup por dia com `ON CONFLICT DO UPDATE`):

| Tabela | Endpoint | Botão na tela |
|---|---|---|
| `fcp_lojas_projecao` | `/api/fluxo-caixa/lojas-projecao` | "Projeção Lojas" |
| `fcp_outras_entradas_projecao` | `/api/fluxo-caixa/outras-entradas-projecao` | "Outras Entradas" |
| `fcp_faturas_descontadas` | `/api/fluxo-caixa/faturas-descontadas` | marca faturas da empresa 001 já descontadas no banco, pra saírem da projeção de Boleto |

Valores manuais pré-cadastrados em Outras Entradas (pedido explícito do usuário): **R$ 390.000,00 em 20/10/2026** e **R$ 3.539.445,01 em 06/11/2026**.

## Saldo acumulado

O saldo diário acumulado exibido na tela é recalculado **no frontend** (`acumLocal`), começando do saldo bancário real (`saldosBancarios.total`) e somando/subtraindo só as colunas **ativas** (toggle de coluna) e **visíveis** — por isso Cartão/Multimarcas, mesmo vindo da API, nunca entram na conta. O backend também calcula seu próprio `dia.saldoAcum`, mas ele inclui cartão/multimarcas e **não é usado pela tela** (inconsistência conhecida e aceita, porque o frontend nunca lê esse campo).

## UI / comportamento da tela

- **Não busca sozinha ao abrir.** O filtro só roda quando o usuário clica em "Aplicar" (removido o `useEffect` de auto-fetch).
- **Atalhos de período** (Hoje, Próximos 7/15/30/60/90 dias, Este Mês) — pra frente, não pra trás como os atalhos de DRE/DFC. Recalculados em cima do "hoje" real sempre que aplicados, mesmo ao restaurar filtro salvo.
- **Filtro sempre persiste** em `localStorage` (`fluxo_caixa_filtros_v1`): empresas, datas, atalho usado, colunas ativas, parâmetros de crescimento.
- **Linha do último dia do mês** fica destacada em verde (`bg-green-200`) na Visão Diária.
- **Zebra (linhas alternadas cinza/branco)**: histórico de bug onde a zebra só aparecia ao tirar print/selecionar texto (bug de repintura do Chrome com `position: sticky` + scroll). Corrigido movendo o background pra cada `<td>` individualmente (em vez de depender do `<tr>` pai) **e** adicionando `[transform:translateZ(0)]` nos containers com scroll das 3 tabelas (Visão Diária, Saldos Bancários, Fornecedor). Se voltar a reclamar que não aparece, suspeitar primeiro de cache (hard refresh `Cmd+Shift+R` no Mac) antes de tocar no CSS de novo.
- **Cartão e Multimarcas**: removidos da tela e do saldo a pedido do usuário "por enquanto" — os dados continuam sendo buscados da API, só não usados. Fácil de trazer de volta (descomentar em `COL_DEFS`).

## Decisões/pendências em aberto

- Se algum dia pedirem pra Cheque também não aparecer em fim de semana, replicar o padrão de `_EXPR_DT_BOLETO_EFETIVA`/`_EXPR_DT_LOJAS_EFETIVA` pra essa coluna.
- Se pedirem pra esconder linhas de sábado/domingo quando todas as colunas visíveis estiverem zeradas (em vez de só mostrar zerado), é mudança na renderização de `linhasDiarias` no `page.tsx`, não no backend.
- Feriados bancários são só nacionais — se precisar de estaduais/municipais (ex. aniversário de cidade), adicionar manualmente em `fcp_feriados_bancarios` ou estender `_feriados_bancarios_do_ano()`.

## Convenções de workflow usadas nesse projeto

- Rodar `npm run build` completo (não só `tsc --noEmit`) antes de dar push em qualquer mudança de frontend — o build pega problemas de ESLint que o tsc não pega. `npm run build` limpa o cache do `.next`, então sempre reiniciar `npm run dev` depois.
- Reiniciar o backend depois de qualquer mudança em `fluxo_caixa.py`: `./venv/bin/python -c "import main; print('OK')"` pra validar import, depois `lsof -ti :8000 | xargs -r kill` e religar com `nohup ./venv/bin/python main.py > /tmp/giro-backend.log 2>&1 &`.
- Commits em português, terminando com `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **Commit/push só acontece com confirmação explícita do usuário** — restart de servidor, leitura/escrita no banco não precisam de confirmação, mas git commit sempre precisa perguntar antes.
