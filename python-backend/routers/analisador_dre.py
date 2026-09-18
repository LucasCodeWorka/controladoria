"""
Analisador de DRE por Empresa (loja fisica) - motor de regras, SEM IA.

Segue a metodologia de 10 etapas definida pelo usuario (rentabilidade,
classificacao de despesas, eficiencia, causa preco x quantidade,
materialidade, oportunidades, diagnostico, perguntas aos gestores, plano
de acao e resumo pra diretoria) usando so aritmetica sobre os valores
mensais por conta que o frontend ja calcula (dreCalculos.ts) - sem
chamar nenhuma API de IA, sem custo/token por execucao.

Por natureza, um motor de regras nao tem julgamento de controller: onde a
metodologia pede causa provavel / acao recomendada, a resposta e sempre
generica (baseada na classificacao contabil da conta), nunca inventada a
partir do numero em si - e cada bloco deixa isso explicito, seguindo a
mesma regra do usuario de "nao presumir causa sem evidencia".
"""
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

router = APIRouter()


# ---------------------------------------------------------------------------
# Classificacao das contas (Etapa 2) e area responsavel (Etapa 8) - por
# grupo (2 niveis, ex "08.01"), com excecoes pontuais por conta-folha onde a
# natureza do gasto diverge do padrao do grupo (ex: horas extras dentro de
# pessoal e controlavel, mesmo o grupo sendo predominantemente fixo).
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
    "08.04.01": "VARIÁVEL",  # premiacoes funcionarios
    "08.04.03": "CONTROLÁVEL",  # rescisao
    "08.04.10": "CONTROLÁVEL",  # horas extras
    "08.04.17": "CONTROLÁVEL",  # gratificacoes
    "08.04.18": "CONTROLÁVEL",  # multa rescisoria
    "08.04.20": "CONTROLÁVEL",  # recrutamento/selecao
    "08.04.23": "SEM INFORMAÇÃO SUFICIENTE",  # co participacao
    "08.04.34": "CONTROLÁVEL",  # horas extras prod
    "08.04.38": "CONTROLÁVEL",  # exames medicos prod
    "08.01.04": "CONTROLÁVEL",  # energia
    "08.01.05": "CONTROLÁVEL",  # ar condicionado
    "08.01.09": "SEM INFORMAÇÃO SUFICIENTE",  # descontos financeiros obtidos
    "08.01.10": "SEM INFORMAÇÃO SUFICIENTE",  # outras despesas de ocupacao
    "08.02.01": "CONTRATUAL/FIXA",  # assessoria juridica
    "08.02.02": "CONTRATUAL/FIXA",  # assessoria contabil
    "08.02.14": "CONTRATUAL/FIXA",  # seguros de imoveis
    "08.02.15": "CONTRATUAL/FIXA",  # aluguel maquineta
    "08.02.17": "CONTRATUAL/FIXA",  # internet
    "08.02.20": "CONTRATUAL/FIXA",  # manutencao de software
    "08.02.21": "CONTRATUAL/FIXA",  # contrib/anuidades
    "08.02.30": "CONTRATUAL/FIXA",  # marcas e patentes
    "08.02.32": "CONTRATUAL/FIXA",  # aluguel imoveis adm
    "08.02.36": "CONTRATUAL/FIXA",  # aluguel maq e equip
    "08.02.37": "CONTRATUAL/FIXA",  # aluguel equip informatica
}

# Limiares (heuristicas) usados pra sinalizar "ponto para investigacao" na
# Etapa 3 - nao concluem desperdicio, so decidem o que entra na lista.
LIMIAR_VARIACAO_PP = 0.5  # pontos percentuais de despesa/receita
LIMIAR_VARIACAO_REL = 0.15  # 15% de variacao relativa no valor da despesa
TOP_N_OPORTUNIDADES = 12


class LojaInfo(BaseModel):
    codigo: str
    nome: str


class AnalisadorDreLojaRequest(BaseModel):
    loja: LojaInfo
    periodo: Dict[str, Any]
    contas: List[Dict[str, Any]]


def fmt_valor(v: float) -> str:
    negativo = v < 0
    v = abs(v)
    texto = f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"-R$ {texto}" if negativo else f"R$ {texto}"


def fmt_pct(v: Optional[float], casas: int = 1) -> str:
    if v is None:
        return "n/d"
    return f"{v:,.{casas}f}%".replace(".", ",")


def media(valores: List[float]) -> Optional[float]:
    valores = [v for v in valores if v is not None]
    if not valores:
        return None
    return sum(valores) / len(valores)


def classificar_conta(codigo: str) -> str:
    if codigo in OVERRIDES_CLASSIFICACAO:
        return OVERRIDES_CLASSIFICACAO[codigo]
    partes = codigo.split(".")
    grupo = ".".join(partes[:2])
    info = GRUPO_INFO.get(grupo)
    return info["classificacao"] if info else "SEM INFORMAÇÃO SUFICIENTE"


def area_responsavel(codigo: str) -> str:
    partes = codigo.split(".")
    grupo = ".".join(partes[:2])
    info = GRUPO_INFO.get(grupo)
    return info["area"] if info else "Controladoria"


def nome_grupo(codigo: str) -> str:
    partes = codigo.split(".")
    grupo = ".".join(partes[:2])
    info = GRUPO_INFO.get(grupo)
    return info["nome"] if info else grupo


def gerar_analise_loja(payload: AnalisadorDreLojaRequest) -> str:
    contas = payload.contas
    periodos: List[str] = payload.periodo.get("periodos") or []
    idx = {c["codigo"]: c for c in contas}

    def valor(codigo: str, periodo: str) -> float:
        c = idx.get(codigo)
        if not c:
            return 0.0
        return float(c.get("valores", {}).get(periodo, 0) or 0)

    def existe(codigo: str) -> bool:
        return codigo in idx

    if not periodos or "03" not in idx:
        return (
            "Não foi possível montar a análise: os dados recebidos não trazem os períodos ou a "
            "Receita Líquida (conta 03) calculada. Confira o período selecionado e tente novamente."
        )

    linhas: List[str] = []
    linhas.append(f"# Análise de Rentabilidade — {payload.loja.nome} (loja {payload.loja.codigo})")
    linhas.append(
        f"**Período: {periodos[0]} a {periodos[-1]} ({len(periodos)} mês(es))** · "
        "Análise gerada automaticamente por regras/aritmética sobre a DRE — **sem uso de IA, sem custo por execução**."
    )
    linhas.append("")
    linhas.append(
        "> As causas apontadas nesta análise são **hipóteses baseadas na classificação contábil da "
        "conta** (contratual, variável, controlável), não uma leitura de contexto de negócio. Toda "
        "conclusão de causa real exige confirmação dos responsáveis (Etapa 8)."
    )
    linhas.append("")

    # =========================================================
    # ETAPA 1 — RENTABILIDADE
    # =========================================================
    linhas.append("## Etapa 1 — Rentabilidade")
    linhas.append("")
    linhas.append(
        "| Mês | Receita Líquida | Margem Contribuição | Margem % | Despesas Operacionais | "
        "Desp.Op/Receita | Resultado Operacional (EBITDA) | EBITDA % | Ocupação/Receita | Pessoal/Receita | "
        "Controláveis/Receita |"
    )
    linhas.append("|---|---|---|---|---|---|---|---|---|---|---|")

    receita_liquida: Dict[str, float] = {}
    ebitda_mes: Dict[str, float] = {}
    ratio_ocupacao: Dict[str, Optional[float]] = {}
    ratio_pessoal: Dict[str, Optional[float]] = {}
    ratio_controlaveis: Dict[str, Optional[float]] = {}

    contas_controlaveis = [
        c for c in contas
        if c.get("tipo") == "conta" and c["codigo"].startswith("08.") and classificar_conta(c["codigo"]) == "CONTROLÁVEL"
    ]

    for p in periodos:
        rl = valor("03", p)
        receita_liquida[p] = rl
        mc = valor("05", p)
        despop = valor("08", p)
        ebitda = valor("09", p)
        ebitda_mes[p] = ebitda
        ocupacao = valor("08.01", p) if existe("08.01") else 0.0
        pessoal = valor("08.04", p) if existe("08.04") else 0.0
        controlaveis = sum(valor(c["codigo"], p) for c in contas_controlaveis)

        rl_abs = abs(rl) if rl else 0
        margem_pct = (mc / rl_abs * 100) if rl_abs else None
        despop_pct = (abs(despop) / rl_abs * 100) if rl_abs else None
        ebitda_pct = (ebitda / rl_abs * 100) if rl_abs else None
        ocup_pct = (abs(ocupacao) / rl_abs * 100) if rl_abs else None
        pessoal_pct = (abs(pessoal) / rl_abs * 100) if rl_abs else None
        ctrl_pct = (abs(controlaveis) / rl_abs * 100) if rl_abs else None

        ratio_ocupacao[p] = ocup_pct
        ratio_pessoal[p] = pessoal_pct
        ratio_controlaveis[p] = ctrl_pct

        linhas.append(
            f"| {p} | {fmt_valor(rl)} | {fmt_valor(mc)} | {fmt_pct(margem_pct)} | {fmt_valor(despop)} | "
            f"{fmt_pct(despop_pct)} | {fmt_valor(ebitda)} | {fmt_pct(ebitda_pct)} | {fmt_pct(ocup_pct)} | "
            f"{fmt_pct(pessoal_pct)} | {fmt_pct(ctrl_pct)} |"
        )

    rl_total = sum(receita_liquida.values())
    ebitda_total = sum(ebitda_mes.values())
    ebitda_pct_total = (ebitda_total / abs(rl_total) * 100) if rl_total else None
    linhas.append(
        f"| **Acumulado** | **{fmt_valor(rl_total)}** | | | | | **{fmt_valor(ebitda_total)}** | "
        f"**{fmt_pct(ebitda_pct_total)}** | | | |"
    )
    linhas.append("")

    # =========================================================
    # ETAPA 2 — CLASSIFICAÇÃO
    # =========================================================
    linhas.append("## Etapa 2 — Classificação das despesas")
    linhas.append("")
    linhas.append("Total do período por conta, classificado em Contratual/Fixa, Variável, Controlável ou Sem informação suficiente:")
    linhas.append("")
    linhas.append("| Conta | Grupo | Classificação | Total período | % das Despesas Operacionais |")
    linhas.append("|---|---|---|---|---|")

    despop_total = sum(valor("08", p) for p in periodos)
    despesas_leaf = sorted(
        (c for c in contas if c.get("tipo") == "conta" and c["codigo"].startswith("08.") and abs(c.get("total", 0)) > 0.005),
        key=lambda c: abs(c.get("total", 0)),
        reverse=True,
    )
    for c in despesas_leaf:
        classe = classificar_conta(c["codigo"])
        pct = (abs(c.get("total", 0)) / abs(despop_total) * 100) if despop_total else None
        linhas.append(f"| {c['nome']} ({c['codigo']}) | {nome_grupo(c['codigo'])} | {classe} | {fmt_valor(c.get('total', 0))} | {fmt_pct(pct)} |")
    linhas.append("")
    linhas.append(
        "Despesas contratuais/fixas relevantes **não devem ser cortadas de imediato** — quando materiais "
        "(ver Etapa 5), o encaminhamento é avaliação/renegociação contratual, não corte."
    )
    linhas.append("")

    # =========================================================
    # ETAPA 3 — ANÁLISE DE EFICIÊNCIA (mês mais recente)
    # =========================================================
    linhas.append("## Etapa 3 — Análise de eficiência (mês mais recente vs. referências)")
    linhas.append("")

    ultimo = periodos[-1]
    anterior = periodos[-2] if len(periodos) >= 2 else None
    historico = periodos[:-1]

    rl_ultimo = receita_liquida[ultimo]
    meses_semelhantes = [
        p for p in historico
        if rl_ultimo != 0 and abs(receita_liquida[p] - rl_ultimo) <= 0.10 * abs(rl_ultimo)
    ]

    linhas.append(
        f"Mês analisado: **{ultimo}**. Mês anterior: **{anterior or 'n/d (só há 1 mês no período)'}**. "
        f"Meses do próprio período com faturamento semelhante (±10%): "
        f"**{', '.join(meses_semelhantes) if meses_semelhantes else 'nenhum'}**."
    )
    linhas.append("")

    contas_analiseeficiencia = sorted(
        (c for c in contas if c.get("tipo") in ("conta", "grupo") and c["codigo"].startswith("08.") and "." in c["codigo"] and len(c["codigo"].split(".")) == 2),
        key=lambda c: abs(c.get("valores", {}).get(ultimo, 0)),
        reverse=True,
    )

    flags: List[Dict[str, Any]] = []
    for c in contas_analiseeficiencia:
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

        variacao_valor_rel = None
        if v_anterior not in (None, 0):
            variacao_valor_rel = (abs(v_ultimo) - abs(v_anterior)) / abs(v_anterior)

        receita_var_rel = None
        if anterior and receita_liquida.get(anterior):
            receita_var_rel = (receita_liquida[ultimo] - receita_liquida[anterior]) / abs(receita_liquida[anterior])

        motivos = []
        if ratio_anterior is not None and ratio_ultimo is not None and (ratio_ultimo - ratio_anterior) >= LIMIAR_VARIACAO_PP:
            motivos.append(f"%receita piorou {fmt_pct(ratio_ultimo - ratio_anterior)} p.p. vs. mês anterior")
        if variacao_valor_rel is not None and receita_var_rel is not None:
            if variacao_valor_rel > LIMIAR_VARIACAO_REL and (receita_var_rel <= 0 or variacao_valor_rel > receita_var_rel + LIMIAR_VARIACAO_REL):
                motivos.append("despesa cresceu mais que a receita (ou receita caiu)")
        if media_semelhantes_ratio is not None and ratio_ultimo is not None and (ratio_ultimo - media_semelhantes_ratio) >= LIMIAR_VARIACAO_PP:
            motivos.append(f"acima da média de meses com faturamento semelhante ({fmt_pct(media_semelhantes_ratio)})")

        if motivos:
            flags.append({
                "codigo": codigo,
                "nome": c["nome"],
                "classificacao": classificar_conta(codigo),
                "v_ultimo": v_ultimo,
                "v_anterior": v_anterior,
                "ratio_ultimo": ratio_ultimo,
                "ratio_anterior": ratio_anterior,
                "media_semelhantes_ratio": media_semelhantes_ratio,
                "motivos": motivos,
                "desvio_mensal": abs(v_ultimo) - abs(v_anterior) if v_anterior is not None else 0,
            })

    if flags:
        linhas.append("| Conta | Classificação | Valor (mês) | %Receita (mês) | Mês anterior | %Receita (anterior) | Motivo(s) sinalizado(s) |")
        linhas.append("|---|---|---|---|---|---|---|")
        for f in flags:
            linhas.append(
                f"| {f['nome']} ({f['codigo']}) | {f['classificacao']} | {fmt_valor(f['v_ultimo'])} | "
                f"{fmt_pct(f['ratio_ultimo'])} | {fmt_valor(f['v_anterior']) if f['v_anterior'] is not None else 'n/d'} | "
                f"{fmt_pct(f['ratio_anterior'])} | {'; '.join(f['motivos'])} |"
            )
    else:
        linhas.append("Nenhuma conta ultrapassou os limiares de sinalização no mês mais recente.")
    linhas.append("")
    linhas.append(
        "Essas sinalizações são **pontos para investigação**, não conclusão de desperdício — sazonalidade, "
        "crescimento de vendas e eventos pontuais podem explicar o desvio (ver Etapa 4)."
    )
    linhas.append("")

    # =========================================================
    # ETAPA 4 — PREÇO X QUANTIDADE
    # =========================================================
    linhas.append("## Etapa 4 — Preço x Quantidade")
    linhas.append("")
    if flags:
        linhas.append(
            "A DRE por conta não traz preço unitário, quantidade/volume ou headcount — portanto, **para "
            "nenhum item sinalizado na Etapa 3 é possível determinar, só com estes dados, se o desvio vem "
            "de preço, quantidade, atividade ou evento extraordinário.** Necessário abrir razão/lançamentos/"
            "notas fiscais para investigar. Dados adicionais a buscar por tipo de conta:"
        )
        linhas.append("")
        vistos = set()
        for f in flags:
            classe = f["classificacao"]
            if classe in vistos:
                continue
            vistos.add(classe)
            if classe == "VARIÁVEL":
                linhas.append(f"- **{classe}**: abrir volume de vendas/transações do mês x valor médio por venda (ticket, comissão %, frete por pedido) para separar efeito preço de efeito volume.")
            elif classe == "CONTROLÁVEL":
                linhas.append(f"- **{classe}**: abrir os principais itens/fornecedores do período, com preço unitário e quantidade comprada/consumida.")
            elif classe == "CONTRATUAL/FIXA":
                linhas.append(f"- **{classe}**: verificar se houve reajuste contratual, mudança de índice ou renegociação no período.")
            else:
                linhas.append(f"- **{classe}**: abrir lançamentos individuais da conta para identificar a natureza do gasto antes de qualquer outra análise.")
    else:
        linhas.append("Sem contas sinalizadas na Etapa 3 para este período.")
    linhas.append("")

    # =========================================================
    # ETAPA 5 — MATERIALIDADE
    # =========================================================
    linhas.append("## Etapa 5 — Materialidade (impacto anualizado)")
    linhas.append("")
    for f in flags:
        f["impacto_anualizado"] = f["desvio_mensal"] * 12
    flags_ordenados = sorted(flags, key=lambda f: abs(f["impacto_anualizado"]), reverse=True)
    if flags_ordenados:
        linhas.append("| Prioridade | Conta | Desvio mensal (vs. mês anterior) | Impacto anualizado |")
        linhas.append("|---|---|---|---|")
        for i, f in enumerate(flags_ordenados, start=1):
            linhas.append(f"| {i} | {f['nome']} ({f['codigo']}) | {fmt_valor(f['desvio_mensal'])} | {fmt_valor(f['impacto_anualizado'])} |")
    else:
        linhas.append("Sem desvios materiais identificados no mês mais recente.")
    linhas.append("")

    # =========================================================
    # ETAPA 6 — OPORTUNIDADES
    # =========================================================
    linhas.append("## Etapa 6 — Oportunidades")
    linhas.append("")
    top_oportunidades = flags_ordenados[:TOP_N_OPORTUNIDADES]
    if top_oportunidades:
        for f in top_oportunidades:
            classe = f["classificacao"]
            area = area_responsavel(f["codigo"])
            if classe == "VARIÁVEL":
                causa = "Possível aumento de preço/tarifa unitária, mix de vendas ou volume — indissociável sem abrir o detalhe (Etapa 4)."
                acao = "Abrir composição da conta por venda/transação do mês e comparar com o mês de referência."
                risco = "Baixo — é levantamento de dado, não corte de despesa."
            elif classe == "CONTROLÁVEL":
                causa = "Possível aumento de consumo, preço do fornecedor ou compra fora do padrão — não determinável só pela DRE."
                acao = "Abrir os principais lançamentos/fornecedores do mês e validar com a área responsável."
                risco = "Baixo a médio, dependendo do item — avaliar antes de qualquer corte."
            elif classe == "CONTRATUAL/FIXA":
                causa = "Possível reajuste contratual (índice, renovação) — não é gasto discricionário do mês."
                acao = "Levantar o contrato vigente e verificar cláusula de reajuste; avaliar renegociação futura."
                risco = "Alto se tratado como corte imediato — despesa contratual não deve ser cortada sem renegociação."
            else:
                causa = "Não determinável com os dados desta DRE."
                acao = "Abrir lançamentos individuais da conta antes de qualquer ação."
                risco = "Indeterminado."

            linhas.append(f"**CONTA:** {f['nome']} ({f['codigo']})")
            linhas.append(f"**PROBLEMA IDENTIFICADO:** {'; '.join(f['motivos'])}")
            linhas.append(
                f"**EVIDÊNCIA:** {fmt_valor(f['v_ultimo'])} no mês ({fmt_pct(f['ratio_ultimo'])} da receita líquida) "
                f"vs. {fmt_valor(f['v_anterior']) if f['v_anterior'] is not None else 'n/d'} no mês anterior "
                f"({fmt_pct(f['ratio_anterior'])} da receita líquida)."
            )
            linhas.append(f"**IMPACTO MENSAL:** {fmt_valor(f['desvio_mensal'])}")
            linhas.append(f"**IMPACTO ANUALIZADO:** {fmt_valor(f['impacto_anualizado'])}")
            linhas.append(f"**CLASSIFICAÇÃO:** {classe}")
            linhas.append(f"**CAUSA PROVÁVEL (hipótese):** {causa}")
            linhas.append("**DADOS NECESSÁRIOS PARA CONFIRMAR:** ver Etapa 4.")
            linhas.append(f"**ÁREA RESPONSÁVEL:** {area}")
            linhas.append(f"**AÇÃO RECOMENDADA:** {acao}")
            linhas.append(f"**PRAZO SUGERIDO:** {'30 dias' if f is top_oportunidades[0] else '60 dias'}")
            linhas.append(f"**RISCO DA AÇÃO:** {risco}")
            linhas.append(f"**ECONOMIA POTENCIAL (não confirmada):** até {fmt_valor(abs(f['impacto_anualizado']))}/ano, se a causa for confirmada e endereçada.")
            linhas.append("")
    else:
        linhas.append("Nenhuma oportunidade material identificada no mês mais recente.")
        linhas.append("")

    # =========================================================
    # ETAPA 7 — DIAGNÓSTICO DA LOJA
    # =========================================================
    linhas.append("## Etapa 7 — Diagnóstico da loja")
    linhas.append("")
    diagnosticos = []
    grupos_flagados = {f["codigo"].rsplit(".", 1)[0] if f["codigo"].count(".") > 1 else f["codigo"] for f in flags_ordenados}
    if any(g.startswith("08.01") for g in grupos_flagados):
        diagnosticos.append("**Problema de ocupação** — despesas do grupo Ocupação (08.01) sinalizadas no mês mais recente.")
    if any(g.startswith("08.04") for g in grupos_flagados):
        diagnosticos.append("**Problema de pessoal** — despesas do grupo Pessoal (08.04) sinalizadas no mês mais recente.")
    if any(classificar_conta(f["codigo"]) == "CONTROLÁVEL" for f in flags_ordenados):
        diagnosticos.append("**Problema de despesas controláveis** — há itens controláveis sinalizados que dependem de validação operacional.")
    if any(classificar_conta(f["codigo"]) == "CONTRATUAL/FIXA" for f in flags_ordenados):
        diagnosticos.append("**Problema contratual** — há despesas contratuais/fixas com peso relevante e desvio no mês, candidatas a avaliação de renegociação.")

    if len(periodos) >= 2:
        rl_primeiro, rl_ultimo_p = receita_liquida[periodos[0]], receita_liquida[periodos[-1]]
        if rl_primeiro and (rl_ultimo_p - rl_primeiro) / abs(rl_primeiro) <= -0.05:
            diagnosticos.append(f"**Problema de vendas** — Receita Líquida caiu {fmt_pct(abs((rl_ultimo_p - rl_primeiro) / rl_primeiro * 100))} entre {periodos[0]} e {periodos[-1]}.")
        eb_primeiro, eb_ultimo_p = ebitda_mes[periodos[0]], ebitda_mes[periodos[-1]]
        rl_p0 = abs(rl_primeiro) if rl_primeiro else None
        rl_pu = abs(rl_ultimo_p) if rl_ultimo_p else None
        margem_eb_primeiro = (eb_primeiro / rl_p0 * 100) if rl_p0 else None
        margem_eb_ultimo = (eb_ultimo_p / rl_pu * 100) if rl_pu else None
        if margem_eb_primeiro is not None and margem_eb_ultimo is not None and (margem_eb_ultimo - margem_eb_primeiro) <= -2:
            diagnosticos.append(f"**Problema de margem** — margem EBITDA caiu {fmt_pct(margem_eb_primeiro - margem_eb_ultimo)} p.p. entre {periodos[0]} e {periodos[-1]}.")

    if diagnosticos:
        for d in diagnosticos:
            linhas.append(f"- {d}")
    else:
        linhas.append("Nenhum padrão de deterioração relevante identificado no período com os limiares aplicados.")
    linhas.append("")

    # =========================================================
    # ETAPA 8 — PERGUNTAS PARA OS GESTORES
    # =========================================================
    linhas.append("## Etapa 8 — Perguntas para os gestores")
    linhas.append("")
    if top_oportunidades:
        for f in top_oportunidades:
            area = area_responsavel(f["codigo"])
            linhas.append(
                f"- **Para {area}:** {f['nome']} ({f['codigo']}) foi de {fmt_valor(f['v_anterior']) if f['v_anterior'] is not None else 'n/d'} "
                f"para {fmt_valor(f['v_ultimo'])} ({fmt_pct(f['ratio_anterior'])} → {fmt_pct(f['ratio_ultimo'])} da Receita Líquida). "
                "Abrir os principais itens/lançamentos responsáveis pelo aumento e informar preço, quantidade, fornecedor e setor solicitante."
            )
    else:
        linhas.append("Sem pontos que exijam pergunta formal aos gestores neste período.")
    linhas.append("")

    # =========================================================
    # ETAPA 9 — PLANO DE AÇÃO
    # =========================================================
    linhas.append("## Etapa 9 — Plano de ação")
    linhas.append("")
    if top_oportunidades:
        linhas.append("| Prioridade | Conta | Problema | Valor atual | Referência | Desvio mensal | Impacto anualizado | Responsável | Ação | Prazo | Status |")
        linhas.append("|---|---|---|---|---|---|---|---|---|---|---|")
        for i, f in enumerate(top_oportunidades, start=1):
            prazo = "30 dias" if i <= 3 else ("60 dias" if i <= 8 else "90 dias")
            acao_curta = "Abrir detalhe e validar com área responsável"
            linhas.append(
                f"| {i} | {f['nome']} ({f['codigo']}) | {'; '.join(f['motivos'])} | {fmt_valor(f['v_ultimo'])} | "
                f"{fmt_valor(f['v_anterior']) if f['v_anterior'] is not None else 'n/d'} | {fmt_valor(f['desvio_mensal'])} | "
                f"{fmt_valor(f['impacto_anualizado'])} | {area_responsavel(f['codigo'])} | {acao_curta} | {prazo} | Aberto |"
            )
    else:
        linhas.append("Sem itens de plano de ação neste período.")
    linhas.append("")

    # =========================================================
    # ETAPA 10 — RESUMO PARA DIRETORIA
    # =========================================================
    linhas.append("## Etapa 10 — Resumo para diretoria")
    linhas.append("")
    valor_oportunidades = sum(abs(f["impacto_anualizado"]) for f in top_oportunidades)
    linhas.append(f"1. **O que aconteceu com a rentabilidade:** Receita Líquida acumulada de {fmt_valor(rl_total)} e "
                   f"Resultado Operacional (EBITDA) acumulado de {fmt_valor(ebitda_total)} ({fmt_pct(ebitda_pct_total)} da receita) no período. [FATO]")
    if diagnosticos:
        linhas.append("2. **Principais causas comprovadas:**")
        for d in diagnosticos:
            linhas.append(f"   - {d} [FATO — baseado em variação numérica; causa raiz ainda não confirmada]")
    else:
        linhas.append("2. **Principais causas comprovadas:** nenhuma variação relevante identificada com os limiares aplicados. [FATO]")
    linhas.append("3. **Principais pontos ainda a investigar:** todos os itens da Etapa 6/8 — nenhuma causa raiz foi confirmada, apenas sinalizada. [HIPÓTESE]")
    linhas.append(f"4. **Valor das oportunidades identificadas:** {fmt_valor(valor_oportunidades)}/ano (potencial, não confirmado). [OPORTUNIDADE]")
    linhas.append("5. **Valor das economias confirmadas:** R$ 0,00 — nenhuma ação foi executada até o momento; todos os valores acima são potenciais. [ECONOMIA CONFIRMADA]")
    if top_oportunidades:
        linhas.append("6. **Ações mais relevantes:**")
        for f in top_oportunidades[:5]:
            linhas.append(f"   - {f['nome']} ({f['codigo']}) — abrir detalhe com {area_responsavel(f['codigo'])}. [AÇÃO]")
    else:
        linhas.append("6. **Ações mais relevantes:** nenhuma ação prioritária identificada neste período.")
    contratuais_materiais = [f for f in top_oportunidades if f["classificacao"] == "CONTRATUAL/FIXA"]
    if contratuais_materiais:
        linhas.append("7. **Decisões que precisam da diretoria:** avaliação de renegociação contratual para:")
        for f in contratuais_materiais:
            linhas.append(f"   - {f['nome']} ({f['codigo']}) — impacto anualizado {fmt_valor(f['impacto_anualizado'])}. [OPORTUNIDADE]")
    else:
        linhas.append("7. **Decisões que precisam da diretoria:** nenhuma decisão contratual pendente identificada neste período.")
    linhas.append("")

    return "\n".join(linhas)


@router.post("/api/dre/analisador-loja")
def gerar_analise_loja_endpoint(payload: AnalisadorDreLojaRequest):
    texto = gerar_analise_loja(payload)
    return {"analise": texto}
