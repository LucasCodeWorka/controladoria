"""
Analisador de DRE por Empresa (loja fisica) - analise de Controller/CFO com IA,
seguindo a metodologia de 10 etapas definida pelo usuario (rentabilidade,
classificacao de despesas, eficiencia, causa preco x quantidade, materialidade,
oportunidades, diagnostico, perguntas aos gestores, plano de acao e resumo pra
diretoria). Mesmo padrao de analise_executiva.py (Anthropic Messages API,
thinking adaptativo, effort alto), mas com prompt e escopo proprios - essa
analise e sempre de UMA loja fisica por vez, nunca consolidado/fabrica.

Pra reduzir erro de aritmetica e deixar a IA focada no que so ela entrega -
interpretacao de causa, priorizacao com julgamento e comunicacao executiva -
o backend pre-calcula em Python (sem IA) os indicadores mensais (Etapa 1), a
classificacao de despesas (Etapa 2) e as sinalizacoes automaticas de
eficiencia/materialidade (Etapas 3 e 5), e manda tudo isso pronto no payload
(`dadosPreCalculados`) junto com a arvore de contas crua. A IA usa esses
numeros como base de verdade e concentra o raciocinio nas etapas 4, 6, 7, 8,
9 e 10.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
import json
import os
import anthropic

router = APIRouter()

MODEL = "claude-opus-5"

# ---------------------------------------------------------------------------
# Classificacao das contas (Etapa 2) e area responsavel (Etapa 8) - por
# grupo (2 niveis, ex "08.01"), com excecoes pontuais por conta-folha onde a
# natureza do gasto diverge do padrao do grupo (ex: horas extras dentro de
# pessoal e controlavel, mesmo o grupo sendo predominantemente fixo). Isso e
# so um ponto de partida pra IA - o prompt deixa claro que ela pode divergir
# dessa classificacao quando o nome da conta indicar outra natureza.
# ---------------------------------------------------------------------------

GRUPO_INFO: Dict[str, Dict[str, str]] = {
    "08.01": {"nome": "Ocupação", "classificacao": "CONTRATUAL/FIXA", "area": "Operações / Facilities"},
    "08.02": {"nome": "Administrativas", "classificacao": "CONTROLÁVEL", "area": "Administrativo/Financeiro"},
    "08.03": {"nome": "Manutenção", "classificacao": "CONTROLÁVEL", "area": "Manutenção/Facilities"},
    "08.04": {"nome": "Pessoal", "classificacao": "CONTRATUAL/FIXA", "area": "RH"},
    "08.05": {"nome": "Marketing", "classificacao": "CONTROLÁVEL", "area": "Marketing"},
    "08.06": {"nome": "Comerciais", "classificacao": "VARIÁVEL", "area": "Comercial"},
    "08.07": {"nome": "Bancárias", "classificacao": "VARIÁVEL", "area": "Financeiro"},
    "08.08": {"nome": "Diretoria", "classificacao": "SEM INFORMAÇÃO SUFICIENTE", "area": "Diretoria"},
    "08.10": {"nome": "Vendas", "classificacao": "VARIÁVEL", "area": "Comercial/Vendas"},
    "08.11": {"nome": "Crédito e Cobrança", "classificacao": "VARIÁVEL", "area": "Financeiro/Cobrança"},
    "08.12": {"nome": "Veículos", "classificacao": "CONTROLÁVEL", "area": "Operações/Logística"},
    "10.03": {"nome": "Despesas Financeiras", "classificacao": "VARIÁVEL", "area": "Financeiro"},
    "13.01": {"nome": "Tributárias sobre Lucro", "classificacao": "CONTRATUAL/FIXA", "area": "Fiscal/Tributário"},
    "02.02": {"nome": "Impostos sobre Vendas", "classificacao": "VARIÁVEL", "area": "Fiscal/Tributário"},
    "04.01": {"nome": "Impostos Diretos", "classificacao": "VARIÁVEL", "area": "Fiscal/Tributário"},
}

OVERRIDES_CLASSIFICACAO: Dict[str, str] = {
    "08.04.01": "VARIÁVEL", "08.04.03": "CONTROLÁVEL", "08.04.10": "CONTROLÁVEL",
    "08.04.17": "CONTROLÁVEL", "08.04.18": "CONTROLÁVEL", "08.04.20": "CONTROLÁVEL",
    "08.04.23": "SEM INFORMAÇÃO SUFICIENTE", "08.04.34": "CONTROLÁVEL", "08.04.38": "CONTROLÁVEL",
    "08.01.04": "CONTROLÁVEL", "08.01.05": "CONTROLÁVEL", "08.01.09": "SEM INFORMAÇÃO SUFICIENTE",
    "08.01.10": "SEM INFORMAÇÃO SUFICIENTE", "08.02.01": "CONTRATUAL/FIXA", "08.02.02": "CONTRATUAL/FIXA",
    "08.02.14": "CONTRATUAL/FIXA", "08.02.15": "CONTRATUAL/FIXA", "08.02.17": "CONTRATUAL/FIXA",
    "08.02.20": "CONTRATUAL/FIXA", "08.02.21": "CONTRATUAL/FIXA", "08.02.30": "CONTRATUAL/FIXA",
    "08.02.32": "CONTRATUAL/FIXA", "08.02.36": "CONTRATUAL/FIXA", "08.02.37": "CONTRATUAL/FIXA",
}

LIMIAR_VARIACAO_PP = 0.5
LIMIAR_VARIACAO_REL = 0.15


def classificar_conta(codigo: str) -> str:
    if codigo in OVERRIDES_CLASSIFICACAO:
        return OVERRIDES_CLASSIFICACAO[codigo]
    grupo = ".".join(codigo.split(".")[:2])
    info = GRUPO_INFO.get(grupo)
    return info["classificacao"] if info else "SEM INFORMAÇÃO SUFICIENTE"


def area_responsavel(codigo: str) -> str:
    grupo = ".".join(codigo.split(".")[:2])
    info = GRUPO_INFO.get(grupo)
    return info["area"] if info else "Controladoria"


def media(valores: List[Optional[float]]) -> Optional[float]:
    v = [x for x in valores if x is not None]
    return sum(v) / len(v) if v else None


def calcular_dados_pre_calculados(contas: List[Dict[str, Any]], periodos: List[str]) -> Dict[str, Any]:
    idx = {c["codigo"]: c for c in contas}

    def valor(codigo: str, periodo: str) -> float:
        c = idx.get(codigo)
        return float(c.get("valores", {}).get(periodo, 0) or 0) if c else 0.0

    contas_controlaveis = [
        c for c in contas
        if c.get("tipo") == "conta" and c["codigo"].startswith("08.") and classificar_conta(c["codigo"]) == "CONTROLÁVEL"
    ]

    receita_liquida: Dict[str, float] = {}
    resumo_mensal = []
    for p in periodos:
        rl = valor("03", p)
        receita_liquida[p] = rl
        rl_abs = abs(rl) if rl else 0
        mc = valor("05", p)
        despop = valor("08", p)
        ebitda = valor("09", p)
        ocupacao = valor("08.01", p)
        pessoal = valor("08.04", p)
        controlaveis = sum(valor(c["codigo"], p) for c in contas_controlaveis)

        resumo_mensal.append({
            "periodo": p,
            "receitaLiquida": round(rl, 2),
            "margemContribuicao": round(mc, 2),
            "margemContribuicaoPct": round(mc / rl_abs * 100, 2) if rl_abs else None,
            "despesasOperacionais": round(despop, 2),
            "despesasOperacionaisPctReceita": round(abs(despop) / rl_abs * 100, 2) if rl_abs else None,
            "resultadoOperacionalEbitda": round(ebitda, 2),
            "resultadoOperacionalEbitdaPct": round(ebitda / rl_abs * 100, 2) if rl_abs else None,
            "custoOcupacao": round(ocupacao, 2),
            "custoOcupacaoPctReceita": round(abs(ocupacao) / rl_abs * 100, 2) if rl_abs else None,
            "pessoal": round(pessoal, 2),
            "pessoalPctReceita": round(abs(pessoal) / rl_abs * 100, 2) if rl_abs else None,
            "despesasControlaveis": round(controlaveis, 2),
            "despesasControlaveisPctReceita": round(abs(controlaveis) / rl_abs * 100, 2) if rl_abs else None,
        })

    despop_total = sum(valor("08", p) for p in periodos)
    despesas_leaf = sorted(
        (c for c in contas if c.get("tipo") == "conta" and c["codigo"].startswith("08.") and abs(c.get("total", 0)) > 0.005),
        key=lambda c: abs(c.get("total", 0)),
        reverse=True,
    )
    classificacao_despesas = [
        {
            "codigo": c["codigo"],
            "nome": c["nome"],
            "classificacao": classificar_conta(c["codigo"]),
            "totalPeriodo": round(c.get("total", 0), 2),
            "pctDespesasOperacionais": round(abs(c.get("total", 0)) / abs(despop_total) * 100, 2) if despop_total else None,
        }
        for c in despesas_leaf
    ]

    # Sinalizacoes automaticas (Etapa 3/5) para o ultimo mes do periodo, com
    # limiares fixos - so um ponto de partida objetivo, a IA pode identificar
    # outros pontos olhando a serie completa em `contas`.
    sinalizacoes = []
    if len(periodos) >= 1:
        ultimo = periodos[-1]
        anterior = periodos[-2] if len(periodos) >= 2 else None
        historico = periodos[:-1]
        rl_ultimo = receita_liquida[ultimo]
        meses_semelhantes = [
            p for p in historico
            if rl_ultimo != 0 and abs(receita_liquida[p] - rl_ultimo) <= 0.10 * abs(rl_ultimo)
        ]

        candidatos = [
            c for c in contas
            if c.get("tipo") in ("conta", "grupo") and c["codigo"].startswith("08.") and len(c["codigo"].split(".")) == 2
        ]
        for c in candidatos:
            codigo = c["codigo"]
            v_ultimo = valor(codigo, ultimo)
            if abs(v_ultimo) < 0.01 and abs(c.get("total", 0)) < 0.01:
                continue
            ratio_ultimo = (abs(v_ultimo) / abs(rl_ultimo) * 100) if rl_ultimo else None
            v_anterior = valor(codigo, anterior) if anterior else None
            ratio_anterior = (abs(v_anterior) / abs(receita_liquida[anterior]) * 100) if anterior and receita_liquida.get(anterior) else None
            media_semelhantes_ratio = media([
                (abs(valor(codigo, p)) / abs(receita_liquida[p]) * 100) if receita_liquida.get(p) else None
                for p in meses_semelhantes
            ]) if meses_semelhantes else None

            variacao_valor_rel = (abs(v_ultimo) - abs(v_anterior)) / abs(v_anterior) if v_anterior else None
            receita_var_rel = (receita_liquida[ultimo] - receita_liquida[anterior]) / abs(receita_liquida[anterior]) if anterior and receita_liquida.get(anterior) else None

            motivos = []
            if ratio_anterior is not None and ratio_ultimo is not None and (ratio_ultimo - ratio_anterior) >= LIMIAR_VARIACAO_PP:
                motivos.append("percentual_sobre_receita_piorou_vs_mes_anterior")
            if variacao_valor_rel is not None and receita_var_rel is not None:
                if variacao_valor_rel > LIMIAR_VARIACAO_REL and (receita_var_rel <= 0 or variacao_valor_rel > receita_var_rel + LIMIAR_VARIACAO_REL):
                    motivos.append("despesa_cresceu_mais_que_receita_ou_receita_caiu")
            if media_semelhantes_ratio is not None and ratio_ultimo is not None and (ratio_ultimo - media_semelhantes_ratio) >= LIMIAR_VARIACAO_PP:
                motivos.append("acima_da_media_de_meses_com_faturamento_semelhante")

            if motivos:
                desvio_mensal = abs(v_ultimo) - abs(v_anterior) if v_anterior is not None else 0
                sinalizacoes.append({
                    "codigo": codigo,
                    "nome": c["nome"],
                    "classificacao": classificar_conta(codigo),
                    "areaResponsavelSugerida": area_responsavel(codigo),
                    "mesAnalisado": ultimo,
                    "mesAnterior": anterior,
                    "valorMesAnalisado": round(v_ultimo, 2),
                    "pctReceitaMesAnalisado": round(ratio_ultimo, 2) if ratio_ultimo is not None else None,
                    "valorMesAnterior": round(v_anterior, 2) if v_anterior is not None else None,
                    "pctReceitaMesAnterior": round(ratio_anterior, 2) if ratio_anterior is not None else None,
                    "mesesComFaturamentoSemelhante": meses_semelhantes,
                    "pctReceitaMediaMesesSemelhantes": round(media_semelhantes_ratio, 2) if media_semelhantes_ratio is not None else None,
                    "motivos": motivos,
                    "desvioMensal": round(desvio_mensal, 2),
                    "impactoAnualizado": round(desvio_mensal * 12, 2),
                })
        sinalizacoes.sort(key=lambda s: abs(s["impactoAnualizado"]), reverse=True)

    return {
        "resumoMensal": resumo_mensal,
        "classificacaoDespesas": classificacao_despesas,
        "sinalizacoesAutomaticas": sinalizacoes,
    }


SYSTEM_PROMPT = """Você atuará como Controller/CFO de uma empresa brasileira de moda e lingerie com \
indústria, lojas físicas e e-commerce.

Sua tarefa é analisar a DRE de UMA LOJA FÍSICA e identificar oportunidades de melhoria de rentabilidade.

IMPORTANTE:
Não presuma que aumento de despesa significa desperdício.
Não recomende cortes sem identificar evidências.
Considere sazonalidade, crescimento de vendas, margem, inflação, mudança de operação e despesas contratuais.

## Dados que você recebe

Você receberá um JSON com a DRE mensal real da loja (extraída do sistema contábil/financeiro), com três blocos:

1. `contas` — a árvore completa de contas (grupos e contas-folha), cada uma com código, nome e o valor mês \
a mês dentro do período. Valores de despesa vêm negativos (redutores de receita). Use este bloco pra \
qualquer comparação que precise de mais de um mês de referência (ano anterior, médias, outros meses).
2. `dadosPreCalculados.resumoMensal` — os indicadores da Etapa 1 (Receita Líquida, Margem de Contribuição \
em R$/%, Despesas Operacionais em R$/%, Resultado Operacional/EBITDA em R$/%, Custo de Ocupação em R$/%, \
Pessoal em R$/%, Despesas Controláveis em R$/%) **já calculados mês a mês** — use esses números como base \
de verdade pra Etapa 1, não precisa recalcular do zero.
3. `dadosPreCalculados.classificacaoDespesas` — cada despesa relevante já classificada em CONTRATUAL/FIXA, \
VARIÁVEL, CONTROLÁVEL ou SEM INFORMAÇÃO SUFICIENTE (Etapa 2), com o total do período e o peso % sobre as \
despesas operacionais. Essa classificação é um ponto de partida automático por regra contábil - **você pode \
e deve divergir dela** quando o nome da conta indicar outra natureza, deixando claro que é uma reclassificação sua.
4. `dadosPreCalculados.sinalizacoesAutomaticas` — pontos que já ultrapassaram limiares objetivos de \
variação no último mês do período (Etapa 3), com o impacto mensal e anualizado já calculado (Etapa 5), \
ordenados por materialidade. Trate como o piso da sua análise, não o teto: você pode e deve identificar \
outros pontos relevantes olhando a série completa em `contas` (incluindo desvios em meses anteriores, não \
só no último mês) — os limiares automáticos são conservadores e não substituem seu julgamento.

Seu valor agregado nesta análise está em: interpretar a causa provável de cada desvio, decidir o que é de \
fato prioritário (nem tudo que a régua automática sinalizou é igualmente relevante, e pode haver coisa \
relevante que ela não sinalizou), formular as perguntas certas pros gestores, e comunicar tudo isso como um \
controller experiente faria numa reunião de diretoria — não repita os números crus, interprete-os.

## Escopo — MUITO IMPORTANTE

Você só tem acesso aos dados do JSON recebido. Não invente, não estime e não presuma números que não \
estão nele (ex: dados de outras lojas, benchmark de mercado, dados de concorrentes, orçado x realizado \
não fornecido, preço unitário, quantidade vendida, headcount). Quando uma etapa depender de dado que não \
veio no JSON ou que não é calculável a partir dele, diga isso explicitamente em vez de fabricar um número.

Analise todos os meses disponíveis no período recebido.

Siga rigorosamente as 10 etapas abaixo, nesta ordem, como estrutura da sua resposta em markdown (use os \
títulos de etapa como cabeçalhos ## ). Pule uma etapa (ou parte dela) apenas quando os dados realmente não \
permitirem, explicando o motivo em uma linha.

=========================
ETAPA 1 — RENTABILIDADE
=========================

Monte a tabela mensal (uma linha por mês, uma tabela markdown) com: Receita líquida; Margem bruta em R$ e \
%; Total das despesas operacionais; Despesas operacionais / Receita líquida; Resultado operacional em R$ e \
%; Custo de ocupação (aluguel + condomínio + fundo de promoção + outros custos de ocupação) em R$ e %; \
Pessoal / Receita líquida; Despesas controláveis / Receita líquida. Use `dadosPreCalculados.resumoMensal` \
como fonte. Comente a evolução mensal e acumulada.

=========================
ETAPA 2 — CLASSIFICAÇÃO
=========================

Apresente a classificação de despesas (A) CONTRATUAL/FIXA, B) VARIÁVEL, C) CONTROLÁVEL, D) SEM INFORMAÇÃO \
SUFICIENTE), partindo de `dadosPreCalculados.classificacaoDespesas` e ajustando onde o nome da conta \
sugerir outra natureza (explique a reclassificação quando divergir).

Não recomende redução imediata de despesas contratuais. Quando forem economicamente relevantes, indique \
necessidade de avaliação contratual ou renegociação futura.

=========================
ETAPA 3 — ANÁLISE DE EFICIÊNCIA
=========================

Parta de `dadosPreCalculados.sinalizacoesAutomaticas` (já traz mês analisado x mês anterior x meses de \
faturamento semelhante, com % sobre receita). Complemente olhando a série completa em `contas`: mesmo mês \
do ano anterior quando disponível, média dos últimos 3 e dos últimos 12 meses, e qualquer outro desvio \
relevante que a régua automática não tenha capturado.

Não conclua que existe desperdício apenas com base nessas situações. Classifique-as como pontos para \
investigação.

=========================
ETAPA 4 — PREÇO X QUANTIDADE
=========================

Quando os dados permitirem, determine se o aumento de uma despesa decorre de: aumento de preço; aumento \
de quantidade/consumo; aumento de atividade; evento extraordinário; mudança contratual; ou combinação \
desses fatores.

Quando a DRE não tiver informações suficientes para determinar a causa, diga explicitamente:
"Necessário abrir razão/lançamentos/notas fiscais para investigar." — e informe exatamente quais dados \
adicionais devem ser buscados.

=========================
ETAPA 5 — MATERIALIDADE
=========================

Não dê a mesma importância para todas as contas. Use o impacto anualizado já calculado em \
`dadosPreCalculados.sinalizacoesAutomaticas` (e calcule o de qualquer ponto adicional que você identificar \
na Etapa 3: diferença mensal recorrente x 12) pra priorizar os desvios com maior impacto potencial sobre o \
resultado.

=========================
ETAPA 6 — OPORTUNIDADES
=========================

Para cada oportunidade identificada, informe, nesse formato:
CONTA:
PROBLEMA IDENTIFICADO:
EVIDÊNCIA:
IMPACTO MENSAL:
IMPACTO ANUALIZADO:
CLASSIFICAÇÃO:
CAUSA PROVÁVEL:
DADOS NECESSÁRIOS PARA CONFIRMAR:
ÁREA RESPONSÁVEL:
AÇÃO RECOMENDADA:
PRAZO SUGERIDO:
RISCO DA AÇÃO:
ECONOMIA POTENCIAL:

Não trate economia potencial como economia realizada.

=========================
ETAPA 7 — DIAGNÓSTICO DA LOJA
=========================

Classifique os problemas encontrados SEM dar uma nota geral à loja:
- problema de vendas; problema de margem; problema de ocupação; problema de pessoal; problema de \
despesas controláveis; problema de produtividade; problema contratual; combinação dos anteriores.

Explique quais evidências sustentam cada diagnóstico.

=========================
ETAPA 8 — PERGUNTAS PARA OS GESTORES
=========================

Crie perguntas objetivas que a Controladoria deve fazer aos responsáveis.

Exemplo — NÃO escrever "Reduzir material de consumo." Escrever: "Material de consumo passou de 0,8% \
para 1,2% da Receita Líquida. Abrir os 10 principais itens responsáveis pelo aumento e verificar preço, \
quantidade, fornecedor e setor solicitante."

Indique quem deve responder: Compras, Operações, Gerente da Loja, RH, Marketing, TI etc. (use \
`areaResponsavelSugerida` como referência, mas ajuste se fizer mais sentido pro caso).

=========================
ETAPA 9 — PLANO DE AÇÃO
=========================

Monte uma tabela final com as colunas: Prioridade, Conta, Problema, Valor atual, Referência, Desvio \
mensal, Impacto anualizado, Responsável, Ação, Prazo, Status.

=========================
ETAPA 10 — RESUMO PARA DIRETORIA
=========================

Finalize com um resumo executivo extremamente objetivo:
1. O que aconteceu com a rentabilidade da loja
2. Principais causas comprovadas
3. Principais pontos ainda a investigar
4. Valor das oportunidades identificadas
5. Valor das economias confirmadas
6. Três a cinco ações mais relevantes
7. Decisões que precisam da diretoria

Não invente causas quando os dados não permitirem conclusão. Separe claramente, usando essas etiquetas \
em cada afirmação relevante do resumo:
FATO
HIPÓTESE
OPORTUNIDADE
AÇÃO
ECONOMIA CONFIRMADA"""


class LojaInfo(BaseModel):
    codigo: str
    nome: str


class AnalisadorDreLojaRequest(BaseModel):
    loja: LojaInfo
    periodo: Dict[str, Any]
    contas: List[Dict[str, Any]]


@router.post("/api/dre/analisador-loja")
def gerar_analise_loja(payload: AnalisadorDreLojaRequest):
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="ANTHROPIC_API_KEY não configurada no backend. Configure a variável de ambiente para habilitar o Analisador de DRE.",
        )

    client = anthropic.Anthropic(api_key=api_key)

    periodos: List[str] = payload.periodo.get("periodos") or []
    dados_pre_calculados = calcular_dados_pre_calculados(payload.contas, periodos)

    user_content = {
        "loja": payload.loja.model_dump(),
        "periodo": payload.periodo,
        "contas": payload.contas,
        "dadosPreCalculados": dados_pre_calculados,
    }

    try:
        # As 10 etapas geram uma resposta longa (max_tokens alto) - usa streaming
        # pra evitar timeout de requisicao, so devolvendo o texto completo no final.
        with client.messages.stream(
            model=MODEL,
            max_tokens=48000,
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": json.dumps(user_content, ensure_ascii=False)}],
        ) as stream:
            response = stream.get_final_message()
    except anthropic.APIError as e:
        raise HTTPException(status_code=502, detail=f"Erro ao chamar a API da Anthropic: {e}")

    if response.stop_reason == "refusal":
        raise HTTPException(status_code=422, detail="A análise não pôde ser gerada para estes dados.")

    texto = "".join(block.text for block in response.content if block.type == "text").strip()

    if not texto:
        raise HTTPException(status_code=502, detail="A API retornou uma resposta vazia.")

    return {"analise": texto}
