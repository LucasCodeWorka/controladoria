from fastapi import APIRouter, HTTPException, Query
from database import execute_query
from routers.dre import MAPEAMENTO_DESPESA_DRE
import indicadores

router = APIRouter()


@router.get("/api/indicadores/pmr")
def get_pmr(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    try:
        print(f"[INFO] Calculando PMR: {dataInicio} até {dataFim}")
        resultado = indicadores.calcular_prazo_medio_recebimento(dataInicio, dataFim)
        print(f"[OK] PMR calculado: {resultado['pmr_dias_ponderado']} dias")
        return resultado
    except Exception as e:
        print(f"[ERROR] Erro ao calcular PMR: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao calcular PMR: {str(e)}"
        )


@router.get("/api/indicadores/pmp")
def get_pmp(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    try:
        print(f"[INFO] Calculando PMP: {dataInicio} até {dataFim}")
        resultado = indicadores.calcular_prazo_medio_pagamento(dataInicio, dataFim)
        print(f"[OK] PMP calculado: {resultado['pmp_dias_ponderado']} dias")
        return resultado
    except Exception as e:
        print(f"[ERROR] Erro ao calcular PMP: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao calcular PMP: {str(e)}"
        )


@router.get("/api/indicadores/ciclo-financeiro")
def get_ciclo_financeiro(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Calcula PMR, PMP e Ciclo Financeiro como MÉDIA dos últimos 12 meses.
    Usa a fórmula contábil para cada mês:

    PMR = (Contas a Receber ÷ Faturamento 12 meses) × 360
    PMP = (Contas a Pagar ÷ Pagamentos 12 meses) × 360
    Ciclo Financeiro = PMR + PME - PMP

    Retorna a média de 12 meses para alinhar com os gráficos.
    """
    try:
        from dateutil.relativedelta import relativedelta
        from datetime import datetime
        import calendar

        print(f"[INFO] Calculando Ciclo Financeiro (MÉDIA 12 meses): {dataInicio} até {dataFim}")

        # Data de referência (fim do período)
        data_fim_dt = datetime.strptime(dataFim, '%Y-%m-%d').date()

        # Calcular valores para cada um dos últimos 12 meses
        pmr_valores = []
        pmp_valores = []
        cf_valores = []
        co_valores = []

        for i in range(12):
            # Mês de referência (indo de 11 meses atrás até o mês atual)
            mes_ref = data_fim_dt - relativedelta(months=11-i)
            ultimo_dia = calendar.monthrange(mes_ref.year, mes_ref.month)[1]
            ultimo_dia_str = f"{mes_ref.year}-{mes_ref.month:02d}-{ultimo_dia:02d}"
            data_12m_atras = (mes_ref - relativedelta(months=12)).strftime('%Y-%m-%d')

            # ===== PMR =====
            query_contas_receber = """
                SELECT COALESCE(SUM(vl_fatura), 0) as contas_receber
                FROM vr_fcr_faturai
                WHERE tp_situacao = 1
                  AND dt_emissao <= %s
                  AND (dt_baixa IS NULL OR dt_baixa > %s)
                  AND tp_baixa = 0
                  AND vl_fatura > 0
                  AND tp_documento NOT IN (7, 10, 11)
            """
            resultado_cr = execute_query(query_contas_receber, (ultimo_dia_str, ultimo_dia_str))
            contas_receber = float(resultado_cr[0].get('contas_receber', 0)) if resultado_cr else 0

            query_faturamento = """
                SELECT COALESCE(SUM(vl_fatura), 0) as faturamento_12m
                FROM vr_fcr_faturai
                WHERE dt_emissao >= %s
                  AND dt_emissao <= %s
                  AND tp_situacao = 1
                  AND vl_fatura > 0
                  AND tp_documento NOT IN (7, 10, 11)
            """
            resultado_fat = execute_query(query_faturamento, (data_12m_atras, ultimo_dia_str))
            faturamento_12m = float(resultado_fat[0].get('faturamento_12m', 0)) if resultado_fat else 0

            pmr_dias = (contas_receber / faturamento_12m) * 360 if faturamento_12m > 0 else 0

            # ===== PMP =====
            query_contas_pagar = """
                SELECT COALESCE(SUM(vl_rateio), 0) as contas_pagar
                FROM vr_fcp_despduplicatai
                WHERE tp_situacao = 'N'
                  AND dt_emissao <= %s
                  AND (dt_baixa IS NULL OR dt_baixa > %s)
                  AND vl_rateio > 0
            """
            resultado_cp = execute_query(query_contas_pagar, (ultimo_dia_str, ultimo_dia_str))
            contas_pagar = float(resultado_cp[0].get('contas_pagar', 0)) if resultado_cp else 0

            query_pagamentos = """
                SELECT COALESCE(SUM(vl_rateio), 0) as pagamentos_12m
                FROM vr_fcp_despduplicatai
                WHERE dt_baixa >= %s
                  AND dt_baixa <= %s
                  AND tp_situacao = 'N'
                  AND vl_rateio > 0
            """
            resultado_pag = execute_query(query_pagamentos, (data_12m_atras, ultimo_dia_str))
            pagamentos_12m = float(resultado_pag[0].get('pagamentos_12m', 0)) if resultado_pag else 0

            pmp_dias = (contas_pagar / pagamentos_12m) * 360 if pagamentos_12m > 0 else 0

            # ===== Ciclos =====
            pme_dias = 31
            ciclo_operacional = pmr_dias + pme_dias
            ciclo_financeiro = ciclo_operacional - pmp_dias

            pmr_valores.append(pmr_dias)
            pmp_valores.append(pmp_dias)
            co_valores.append(ciclo_operacional)
            cf_valores.append(ciclo_financeiro)

        # Calcular médias
        pmr_media = sum(pmr_valores) / len(pmr_valores) if pmr_valores else 0
        pmp_media = sum(pmp_valores) / len(pmp_valores) if pmp_valores else 0
        co_media = sum(co_valores) / len(co_valores) if co_valores else 0
        cf_media = sum(cf_valores) / len(cf_valores) if cf_valores else 0
        pme_dias = 31

        # Determinar status baseado na média
        if cf_media < 0:
            status = "POSITIVO"
            cor = "green"
            mensagem = f"Excelente! A empresa recebe dos fornecedores antes de pagar aos clientes ({abs(cf_media):.1f} dias de folga)."
        elif cf_media < 30:
            status = "BOM"
            cor = "blue"
            mensagem = f"Bom! A empresa tem um ciclo financeiro curto ({cf_media:.1f} dias em média)."
        elif cf_media < 60:
            status = "ATENCAO"
            cor = "yellow"
            mensagem = f"Atenção! O ciclo financeiro médio está em {cf_media:.1f} dias."
        else:
            status = "CRITICO"
            cor = "red"
            mensagem = f"Crítico! O ciclo financeiro médio está muito longo ({cf_media:.1f} dias)."

        resultado = {
            'pmr_dias': round(pmr_media, 1),
            'pme_dias': pme_dias,
            'pmp_dias': round(pmp_media, 1),
            'ciclo_operacional_dias': round(co_media, 1),
            'ciclo_financeiro_dias': round(cf_media, 1),
            'interpretacao': {
                'status': status,
                'cor': cor,
                'mensagem': mensagem
            },
            'periodo': {
                'data_inicio': dataInicio,
                'data_fim': dataFim,
                'tipo_calculo': 'media_12_meses'
            },
            'detalhes': {
                'pmr_min': round(min(pmr_valores), 1) if pmr_valores else 0,
                'pmr_max': round(max(pmr_valores), 1) if pmr_valores else 0,
                'pmp_min': round(min(pmp_valores), 1) if pmp_valores else 0,
                'pmp_max': round(max(pmp_valores), 1) if pmp_valores else 0,
                'cf_min': round(min(cf_valores), 1) if cf_valores else 0,
                'cf_max': round(max(cf_valores), 1) if cf_valores else 0,
            },
            'formula': 'contabil_media_12m',
            'fonte': 'vCenter'
        }

        print(f"[OK] Ciclo Financeiro (MÉDIA 12m): {cf_media:.1f} dias (PMR: {pmr_media:.1f}, PMP: {pmp_media:.1f}, CO: {co_media:.1f})")
        return resultado

    except Exception as e:
        print(f"[ERROR] Erro ao calcular Ciclo Financeiro vCenter: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao calcular Ciclo Financeiro: {str(e)}"
        )


@router.get("/api/indicadores/detalhes-pmr")
def get_detalhes_pmr(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Retorna os detalhes de recebimentos para o PMR (PostgreSQL vCenter)
    """
    try:
        print(f"[INFO] Buscando detalhes PMR vCenter: {dataInicio} até {dataFim}")

        query = """
            SELECT
                i.cd_empresa,
                i.cd_cliente,
                i.nr_fat,
                i.nr_parcela,
                i.dt_emissao,
                i.dt_vencimento,
                i.dt_baixa,
                i.vl_fatura,
                i.tp_documento,
                COALESCE(p.nm_pessoa, 'N/A') as nm_cliente,
                EXTRACT(DAY FROM (i.dt_baixa - i.dt_emissao)) as dias_para_receber
            FROM
                vr_fcr_faturai i
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = i.cd_cliente
            WHERE
                i.tp_situacao = 1
                AND i.dt_baixa >= %s
                AND i.dt_baixa <= %s
                AND i.dt_baixa IS NOT NULL
                AND i.vl_fatura > 0
                AND i.tp_baixa NOT IN (6, 8, 11, 12)
                AND i.tp_documento NOT IN (7, 10, 11)
            ORDER BY i.dt_baixa DESC
        """

        faturas = execute_query(query, (dataInicio, dataFim))

        valor_total = sum(float(f['vl_fatura'] or 0) for f in faturas)

        print(f"[OK] {len(faturas)} faturas encontradas vCenter. Total: R$ {valor_total:,.2f}")

        return {
            "faturas": faturas,
            "total_faturas": len(faturas),
            "valor_total": valor_total,
            "periodo": {
                "data_inicio": dataInicio,
                "data_fim": dataFim
            },
            "fonte": "vCenter"
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar detalhes PMR vCenter: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar detalhes PMR: {str(e)}"
        )


@router.get("/api/indicadores/detalhes-pmp")
def get_detalhes_pmp(
    dataInicio: str = Query("2026-01-01", description="Data inicial (YYYY-MM-DD)"),
    dataFim: str = Query("2026-12-31", description="Data final (YYYY-MM-DD)")
):
    """
    Retorna os detalhes de pagamentos para o PMP (PostgreSQL vCenter)
    """
    try:
        print(f"[INFO] Buscando detalhes PMP vCenter: {dataInicio} até {dataFim}")

        query = """
            SELECT
                d.cd_empresa,
                d.cd_fornecedor,
                d.nr_duplicata,
                d.dt_emissao,
                d.dt_vencimento,
                d.dt_baixa,
                d.vl_rateio,
                d.cd_despesaitem,
                di.ds_despesaitem,
                COALESCE(p.nm_pessoa, 'N/A') as nm_fornecedor,
                EXTRACT(DAY FROM (d.dt_baixa - d.dt_emissao)) as dias_para_pagar
            FROM
                vr_fcp_despduplicatai d
                LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = d.cd_fornecedor
                LEFT JOIN vr_fcp_despesaitem di ON di.cd_despesaitem = d.cd_despesaitem
            WHERE
                d.tp_situacao = 'N'
                AND d.dt_baixa >= %s
                AND d.dt_baixa <= %s
                AND d.dt_baixa IS NOT NULL
                AND d.vl_rateio > 0
            ORDER BY d.dt_baixa DESC
        """

        duplicatas = execute_query(query, (dataInicio, dataFim))

        valor_total = sum(float(d['vl_rateio'] or 0) for d in duplicatas)

        print(f"[OK] {len(duplicatas)} duplicatas encontradas vCenter. Total: R$ {valor_total:,.2f}")

        return {
            "duplicatas": duplicatas,
            "total_duplicatas": len(duplicatas),
            "valor_total": valor_total,
            "periodo": {
                "data_inicio": dataInicio,
                "data_fim": dataFim
            },
            "fonte": "vCenter"
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar detalhes PMP vCenter: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar detalhes PMP: {str(e)}"
        )


@router.get("/api/indicadores/ecommerce")
def get_ecommerce(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM)")
):
    """
    Retorna receita líquida do e-commerce (empresa 120) para o mês e o mesmo mês do ano anterior.
    """
    try:
        import calendar

        ano, mes = mesReferencia.split('-')
        primeiro_dia = f"{ano}-{mes}-01"
        ultimo_dia_num = calendar.monthrange(int(ano), int(mes))[1]
        ultimo_dia = f"{ano}-{mes}-{ultimo_dia_num:02d}"

        ano_ant = str(int(ano) - 1)
        primeiro_dia_ant = f"{ano_ant}-{mes}-01"
        ultimo_dia_ant_num = calendar.monthrange(int(ano_ant), int(mes))[1]
        ultimo_dia_ant = f"{ano_ant}-{mes}-{ultimo_dia_ant_num:02d}"

        print(f"[INFO] E-commerce: atual={primeiro_dia}~{ultimo_dia}, ant={primeiro_dia_ant}~{ultimo_dia_ant}")

        def buscar_liq(data_ini, data_fim):
            r_v = execute_query("""
                SELECT COALESCE(SUM(t.vl_transacao), 0) AS total
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4 AND t.tp_modalidade IN ('4')
                  AND t.tp_operacao = 'S' AND t.cd_empresa = 120
            """, (data_ini, data_fim))
            r_d = execute_query("""
                SELECT COALESCE(SUM(t.vl_transacao), 0) AS total
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4 AND t.tp_modalidade IN ('3')
                  AND t.tp_operacao = 'E' AND t.cd_empresa = 120
            """, (data_ini, data_fim))
            return float(r_v[0]['total']) - float(r_d[0]['total'])

        liq_atual = buscar_liq(primeiro_dia, ultimo_dia)
        liq_ant = buscar_liq(primeiro_dia_ant, ultimo_dia_ant)
        variacao = ((liq_atual - liq_ant) / liq_ant * 100) if liq_ant else 0

        print(f"[OK] E-commerce atual={liq_atual:.2f}, ant={liq_ant:.2f}, var={variacao:.2f}%")

        return {
            "mes_referencia": mesReferencia,
            "ecommerce_atual": liq_atual,
            "ecommerce_ano_anterior": liq_ant,
            "variacao_yoy": round(variacao, 2),
            "fonte": "vCenter"
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar e-commerce: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar e-commerce: {str(e)}")


@router.get("/api/indicadores/cresc-faturamento")
def get_cresc_faturamento(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM)")
):
    """
    Retorna crescimento do faturamento acumulado da empresa 1.
    """
    try:
        import calendar

        ano, mes = mesReferencia.split('-')
        ultimo_dia = calendar.monthrange(int(ano), int(mes))[1]

        data_inicio_atual = f"{ano}-01-01"
        data_fim_atual    = f"{ano}-{mes}-{ultimo_dia:02d}"

        ano_ant = str(int(ano) - 1)
        data_inicio_ant = f"{ano_ant}-01-01"
        data_fim_ant    = f"{ano_ant}-{mes}-{ultimo_dia:02d}"

        print(f"[INFO] Cresc. Fat.: atual={data_inicio_atual}~{data_fim_atual}, ant={data_inicio_ant}~{data_fim_ant}")

        def buscar_liquido(data_ini, data_fim):
            r_v = execute_query("""
                SELECT COALESCE(SUM(t.vl_transacao), 0) AS total
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.tp_modalidade IN ('4')
                  AND t.tp_operacao = 'S'
                  AND t.cd_empresa = 1
            """, (data_ini, data_fim))
            r_d = execute_query("""
                SELECT COALESCE(SUM(t.vl_transacao), 0) AS total
                FROM vr_tra_transacao t
                WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s
                  AND t.tp_situacao = 4
                  AND t.tp_modalidade IN ('3')
                  AND t.tp_operacao = 'E'
                  AND t.cd_empresa = 1
            """, (data_ini, data_fim))
            return float(r_v[0]['total']) - float(r_d[0]['total'])

        fat_atual = buscar_liquido(data_inicio_atual, data_fim_atual)
        fat_ant   = buscar_liquido(data_inicio_ant,   data_fim_ant)
        variacao  = ((fat_atual - fat_ant) / fat_ant * 100) if fat_ant else 0

        print(f"[OK] Cresc. Fat.: atual={fat_atual:,.2f}, ant={fat_ant:,.2f}, var={variacao:.2f}%")

        return {
            "mes_referencia": mesReferencia,
            "fat_atual": fat_atual,
            "fat_anterior": fat_ant,
            "variacao_percentual": round(variacao, 2),
            "periodo_atual": {"data_inicio": data_inicio_atual, "data_fim": data_fim_atual},
            "periodo_anterior": {"data_inicio": data_inicio_ant, "data_fim": data_fim_ant},
            "fonte": "vCenter"
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar cresc. faturamento: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar cresc. faturamento: {str(e)}")


@router.get("/api/indicadores/lucro-liquido")
def get_lucro_liquido(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM)")
):
    """
    Retorna o percentual de empresas com lucro líquido positivo no mês.
    """
    try:
        import calendar

        ano, mes = mesReferencia.split('-')
        primeiro_dia = f"{ano}-{mes}-01"
        ultimo_dia_num = calendar.monthrange(int(ano), int(mes))[1]
        ultimo_dia = f"{ano}-{mes}-{ultimo_dia_num:02d}"

        # Só os cd_despesaitem que entram no lucro líquido (exclui 17.01 e 18)
        CONTAS_EXCLUIDAS = {'17.01', '18'}
        cds_incluidos = [
            cd for cd, conta in MAPEAMENTO_DESPESA_DRE.items()
            if not any(conta == ex or conta.startswith(ex + '.') for ex in CONTAS_EXCLUIDAS)
        ]
        placeholders_inc = ','.join(['%s'] * len(cds_incluidos))

        params_desp = [primeiro_dia, ultimo_dia] + cds_incluidos
        query_despesas = f"""
            SELECT
                d.cd_ccusto AS cd_empresa,
                ABS(SUM(d.vl_rateio)) AS total_despesa
            FROM vr_fcp_despduplicatai d
            WHERE d.dt_emissao >= %s
              AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_despesaitem IN ({placeholders_inc})
            GROUP BY d.cd_ccusto
        """
        despesas_raw = execute_query(query_despesas, tuple(params_desp))

        CCUSTOS_FABRICA = set(range(500, 516))
        despesas_por_empresa: dict = {}
        for r in despesas_raw:
            cd = r['cd_empresa']
            val = float(r['total_despesa'] or 0)
            cd_real = 1 if cd in CCUSTOS_FABRICA else cd
            despesas_por_empresa[cd_real] = despesas_por_empresa.get(cd_real, 0) + val

        cmv_lojas_raw = execute_query("""
            SELECT idcentrodecusto AS cd_empresa, ABS(SUM(valor)) AS cmv
            FROM mv_cmv_loja
            WHERE data >= %s AND data <= %s
            GROUP BY idcentrodecusto
        """, (primeiro_dia, ultimo_dia))
        cmv_por_empresa = {r['cd_empresa']: float(r['cmv'] or 0) for r in cmv_lojas_raw}

        cmv_fab_raw = execute_query("""
            SELECT ABS(COALESCE(SUM(valor), 0)) AS cmv FROM mv_cmv_fab
            WHERE data >= %s AND data <= %s
        """, (primeiro_dia, ultimo_dia))
        if cmv_fab_raw:
            cmv_fab = float(cmv_fab_raw[0]['cmv'] or 0)
            cmv_por_empresa[1] = cmv_por_empresa.get(1, 0) + cmv_fab

        fat_por_empresa = execute_query("""
            SELECT
                t.cd_empresa,
                COALESCE(p.nm_fantasia, p.nm_pessoa, 'Empresa ' || t.cd_empresa::text) AS nome,
                SUM(CASE WHEN t.tp_modalidade = '4' AND t.tp_operacao = 'S' THEN t.vl_transacao ELSE 0 END)
                - SUM(CASE WHEN t.tp_modalidade = '3' AND t.tp_operacao = 'E' THEN t.vl_transacao ELSE 0 END)
                AS faturamento_liquido
            FROM vr_tra_transacao t
            LEFT JOIN vr_ger_empresa e ON e.cd_empresa = t.cd_empresa
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = e.cd_pessoa
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
            GROUP BY t.cd_empresa, p.nm_fantasia, p.nm_pessoa
        """, (primeiro_dia, ultimo_dia))

        fat_map   = {r['cd_empresa']: float(r['faturamento_liquido'] or 0) for r in fat_por_empresa}
        nomes_map = {r['cd_empresa']: r['nome'] for r in fat_por_empresa}

        todas_empresas = {cd for cd, fat in fat_map.items() if fat > 0}
        empresas_detalhes = []
        for cd_emp in todas_empresas:
            fat = fat_map.get(cd_emp, 0)
            desp = despesas_por_empresa.get(cd_emp, 0)
            cmv = cmv_por_empresa.get(cd_emp, 0)
            lucro = fat - desp - cmv
            empresas_detalhes.append({
                "cd_empresa": cd_emp,
                "nome": nomes_map.get(cd_emp, f"Empresa {cd_emp}"),
                "faturamento_liquido": round(fat, 2),
                "total_despesas": round(desp, 2),
                "cmv": round(cmv, 2),
                "lucro_liquido": round(lucro, 2),
                "margem": round((lucro / fat * 100), 2) if fat > 0 else None,
                "positivo": lucro > 0,
            })

        empresas_detalhes.sort(key=lambda x: x['lucro_liquido'], reverse=True)

        total_empresas = len(empresas_detalhes)
        positivas = sum(1 for e in empresas_detalhes if e['positivo'])
        negativas = total_empresas - positivas
        percentual_positivas = round(positivas / total_empresas * 100, 1) if total_empresas > 0 else 0

        return {
            "mes_referencia": mesReferencia,
            "percentual_positivas": percentual_positivas,
            "total_empresas": total_empresas,
            "positivas": positivas,
            "negativas": negativas,
            "empresas": empresas_detalhes,
        }

    except Exception as e:
        print(f"[ERROR] /api/indicadores/lucro-liquido: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao calcular lucro líquido: {str(e)}")


@router.get("/api/indicadores/lucro-liquido-12m")
def get_lucro_liquido_12m(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM) — calcula os 12 meses anteriores")
):
    """
    Média mensal de % de empresas lucrativas nos últimos 12 meses.
    """
    try:
        import calendar, datetime

        ano, mes = int(mesReferencia.split('-')[0]), int(mesReferencia.split('-')[1])

        meses = []
        for i in range(11, -1, -1):
            m = mes - i
            a = ano
            while m <= 0:
                m += 12
                a -= 1
            meses.append((a, m))

        inicio = datetime.date(meses[0][0], meses[0][1], 1)
        primeiro_dia = inicio.isoformat()
        ultimo_dia_num = calendar.monthrange(ano, mes)[1]
        ultimo_dia = f"{ano}-{mes:02d}-{ultimo_dia_num:02d}"

        MESES_PT = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ']
        periodo = f"{MESES_PT[meses[0][1]-1]}/{meses[0][0]} – {MESES_PT[mes-1]}/{ano}"

        CONTAS_EXCLUIDAS = {'17.01', '18'}
        cds_incluidos = [
            cd for cd, conta in MAPEAMENTO_DESPESA_DRE.items()
            if not any(conta == ex or conta.startswith(ex + '.') for ex in CONTAS_EXCLUIDAS)
        ]
        placeholders_inc = ','.join(['%s'] * len(cds_incluidos))
        CCUSTOS_FABRICA = set(range(500, 516))

        def mes_key(dt):
            return str(dt)[:7]

        fat_raw = execute_query("""
            SELECT t.cd_empresa,
                   DATE_TRUNC('month', t.dt_transacao) AS mes,
                   COALESCE(p.nm_fantasia, p.nm_pessoa, 'Empresa ' || t.cd_empresa::text) AS nome,
                   SUM(CASE WHEN t.tp_modalidade = '4' AND t.tp_operacao = 'S' THEN t.vl_transacao ELSE 0 END)
                   - SUM(CASE WHEN t.tp_modalidade = '3' AND t.tp_operacao = 'E' THEN t.vl_transacao ELSE 0 END)
                   AS faturamento_liquido
            FROM vr_tra_transacao t
            LEFT JOIN vr_ger_empresa e ON e.cd_empresa = t.cd_empresa
            LEFT JOIN vr_pes_pessoa p ON p.cd_pessoa = e.cd_pessoa
            WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s AND t.tp_situacao = 4
            GROUP BY t.cd_empresa, DATE_TRUNC('month', t.dt_transacao), p.nm_fantasia, p.nm_pessoa
        """, (primeiro_dia, ultimo_dia))

        fat_map: dict = {}
        nomes_map: dict = {}
        for r in fat_raw:
            mk = mes_key(r['mes'])
            cd = r['cd_empresa']
            fat_map.setdefault(mk, {})[cd] = float(r['faturamento_liquido'] or 0)
            nomes_map[cd] = r['nome']

        params_desp = [primeiro_dia, ultimo_dia] + cds_incluidos
        desp_raw = execute_query(f"""
            SELECT d.cd_ccusto AS cd_ccusto,
                   DATE_TRUNC('month', d.dt_emissao) AS mes,
                   ABS(SUM(d.vl_rateio)) AS total_despesa
            FROM vr_fcp_despduplicatai d
            WHERE d.dt_emissao >= %s AND d.dt_emissao <= %s
              AND d.tp_situacao = 'N'
              AND d.cd_despesaitem IN ({placeholders_inc})
            GROUP BY d.cd_ccusto, DATE_TRUNC('month', d.dt_emissao)
        """, tuple(params_desp))

        desp_map: dict = {}
        for r in desp_raw:
            mk = mes_key(r['mes'])
            cd = r['cd_ccusto']
            cd_real = 1 if cd in CCUSTOS_FABRICA else cd
            val = float(r['total_despesa'] or 0)
            desp_map.setdefault(mk, {})
            desp_map[mk][cd_real] = desp_map[mk].get(cd_real, 0) + val

        cmv_loja_raw = execute_query("""
            SELECT idcentrodecusto AS cd_empresa,
                   DATE_TRUNC('month', data) AS mes,
                   ABS(SUM(valor)) AS cmv
            FROM mv_cmv_loja WHERE data >= %s AND data <= %s
            GROUP BY idcentrodecusto, DATE_TRUNC('month', data)
        """, (primeiro_dia, ultimo_dia))

        cmv_loja_map: dict = {}
        for r in cmv_loja_raw:
            mk = mes_key(r['mes'])
            cmv_loja_map.setdefault(mk, {})[r['cd_empresa']] = float(r['cmv'] or 0)

        cmv_fab_raw = execute_query("""
            SELECT DATE_TRUNC('month', data) AS mes, ABS(COALESCE(SUM(valor), 0)) AS cmv
            FROM mv_cmv_fab WHERE data >= %s AND data <= %s
            GROUP BY DATE_TRUNC('month', data)
        """, (primeiro_dia, ultimo_dia))

        cmv_fab_map: dict = {mes_key(r['mes']): float(r['cmv'] or 0) for r in cmv_fab_raw}

        lucro_por_mes: dict = {}

        for a, m in meses:
            mk = f"{a}-{m:02d}"
            fat_mes      = fat_map.get(mk, {})
            desp_mes     = desp_map.get(mk, {})
            cmv_loja_mes = cmv_loja_map.get(mk, {})
            cmv_fab_mes  = cmv_fab_map.get(mk, 0)

            for cd, fat in fat_mes.items():
                if fat <= 0:
                    continue
                desp = desp_mes.get(cd, 0)
                cmv  = cmv_loja_mes.get(cd, 0) + (cmv_fab_mes if cd == 1 else 0)
                lucro_por_mes.setdefault(cd, {})[mk] = fat - desp - cmv

        todas_empresas = set(lucro_por_mes.keys())
        empresas_detalhes = []
        for cd_emp in todas_empresas:
            lucros_mensais = list(lucro_por_mes[cd_emp].values())
            n_meses = len(lucros_mensais)
            lucro_medio = sum(lucros_mensais) / n_meses

            fat_total  = sum(fat_map.get(f"{a}-{m:02d}", {}).get(cd_emp, 0) for a, m in meses)
            desp_total = sum(desp_map.get(f"{a}-{m:02d}", {}).get(cd_emp, 0) for a, m in meses)
            cmv_total  = sum(
                cmv_loja_map.get(f"{a}-{m:02d}", {}).get(cd_emp, 0)
                + (cmv_fab_map.get(f"{a}-{m:02d}", 0) if cd_emp == 1 else 0)
                for a, m in meses
            )
            fat_medio  = fat_total  / n_meses
            desp_medio = desp_total / n_meses
            cmv_medio  = cmv_total  / n_meses

            empresas_detalhes.append({
                "cd_empresa": cd_emp,
                "nome": nomes_map.get(cd_emp, f"Empresa {cd_emp}"),
                "faturamento_liquido": round(fat_medio, 2),
                "total_despesas": round(desp_medio, 2),
                "cmv": round(cmv_medio, 2),
                "lucro_liquido": round(lucro_medio, 2),
                "margem": round((lucro_medio / fat_medio * 100), 2) if fat_medio > 0 else None,
                "positivo": lucro_medio > 0,
            })

        empresas_detalhes.sort(key=lambda x: x['lucro_liquido'], reverse=True)
        total_empresas = len(empresas_detalhes)
        positivas = sum(1 for e in empresas_detalhes if e['positivo'])
        percentual_positivas = round(positivas / total_empresas * 100, 1) if total_empresas > 0 else 0

        return {
            "periodo": periodo,
            "mes_referencia": mesReferencia,
            "percentual_positivas": percentual_positivas,
            "total_empresas": total_empresas,
            "positivas": positivas,
            "negativas": total_empresas - positivas,
            "empresas": empresas_detalhes,
        }

    except Exception as e:
        print(f"[ERROR] /api/indicadores/lucro-liquido-12m: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao calcular lucro líquido 12M: {str(e)}")


@router.get("/api/indicadores/quebra")
def get_quebra(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM)")
):
    """
    Retorna a quebra de pedidos (cd_motivocanc=6) para o mês de referência.
    """
    try:
        import calendar

        ano, mes = mesReferencia.split('-')
        primeiro_dia = f"{ano}-{mes}-01"
        ultimo_dia_num = calendar.monthrange(int(ano), int(mes))[1]
        ultimo_dia = f"{ano}-{mes}-{ultimo_dia_num:02d}"

        print(f"[INFO] Quebra: {primeiro_dia} ~ {ultimo_dia}")

        result = execute_query("""
            WITH ult AS (
                SELECT
                    a.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY a.cd_empresa, a.cd_pedido, a.cd_produto
                        ORDER BY a.dt_cadastro DESC
                    ) AS rn
                FROM vr_ped_pedidoicanc2 a
                WHERE a.dt_cadastro >= %s AND a.dt_cadastro <= %s
            )
            SELECT
                COALESCE(SUM(b.vl_unitario * b.qt_cancelada), 0) AS quebra_valor,
                COUNT(*) AS quebra_count
            FROM ult u
            JOIN vr_ped_pedidoi b
                ON u.cd_pedido = b.cd_pedido
               AND u.cd_empresa = b.cd_empresa
               AND u.cd_produto = b.cd_produto
            WHERE u.rn = 1
              AND u.cd_motivocanc = 6
              AND b.cd_operacao IN (52, 1)
              AND b.cd_representant <> 110000001
        """, (primeiro_dia, ultimo_dia))

        quebra_valor = float(result[0]['quebra_valor'])
        quebra_count = int(result[0]['quebra_count'])

        fat_result = execute_query("""
            SELECT COALESCE(SUM(t.vl_transacao), 0) AS total
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.tp_modalidade IN ('4')
              AND t.tp_operacao = 'S'
              AND t.cd_empresa = 1
        """, (primeiro_dia, ultimo_dia))

        faturamento_empresa1 = float(fat_result[0]['total'])
        quebra_percentual = (quebra_valor / faturamento_empresa1 * 100) if faturamento_empresa1 > 0 else 0

        print(f"[OK] Quebra: R$ {quebra_valor:,.2f}, {quebra_count} itens, {quebra_percentual:.2f}%")

        return {
            "mes_referencia": mesReferencia,
            "quebra_valor": quebra_valor,
            "quebra_count": quebra_count,
            "quebra_percentual": round(quebra_percentual, 2),
            "faturamento_empresa1": faturamento_empresa1,
            "periodo": {
                "data_inicio": primeiro_dia,
                "data_fim": ultimo_dia
            },
            "fonte": "vCenter"
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar quebra: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar quebra: {str(e)}")


@router.get("/api/indicadores/giro-lojas")
def get_giro_lojas(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM)")
):
    """
    Retorna o Giro PA Lojas do mês de referência.
    """
    try:
        import calendar

        ano, mes = mesReferencia.split('-')
        primeiro_dia = f"{ano}-{mes}-01"
        ultimo_dia_num = calendar.monthrange(int(ano), int(mes))[1]
        ultimo_dia = f"{ano}-{mes}-{ultimo_dia_num:02d}"
        doze_meses_atras = f"{int(ano) - 1}-{mes}-01"

        try:
            cached = execute_query(
                "SELECT giro, estoque_total, venda_liquida_media FROM mv_giro_lojas_mensal WHERE mes_referencia = %s",
                (primeiro_dia,)
            )
            if cached:
                row = cached[0]
                giro = float(row.get('giro') or 0)
                print(f"[OK] Giro Lojas (cache): giro={giro:.4f}")
                return {
                    "mes_referencia": mesReferencia,
                    "giro": round(giro, 4),
                    "estoque_total": float(row.get('estoque_total') or 0),
                    "venda_liquida_media_mensal": float(row.get('venda_liquida_media') or 0),
                    "fonte": "cache"
                }
        except Exception:
            pass

        print(f"[INFO] Giro Lojas (query pesada): lojas={primeiro_dia}~{ultimo_dia}, vendas={doze_meses_atras}~{primeiro_dia}, estoque={primeiro_dia}")

        result = execute_query("""
            WITH lojas AS (
                SELECT DISTINCT t.cd_empresa::text AS cd_empresa_txt
                FROM vr_tra_transacao t
                JOIN vr_tra_transitem i
                    ON i.cd_empresa = t.cd_empresa
                   AND i.dt_transacao = t.dt_transacao
                   AND i.nr_transacao = t.nr_transacao
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao <= %s
                  AND t.cd_empresa <> ALL (ARRAY[1::bigint, 120::bigint])
                  AND t.cd_operacao <> ALL (ARRAY[140, 76, 25, 26, 27, 273, 44, 240, 241, 242, 243, 244, 245, 239, 238, 237, 236])
                  AND i.cd_compvend <> 1
                  AND t.tp_situacao <> 6
                  AND (t.tp_modalidade)::text = ANY (ARRAY['2','3','4','8'])
            ),
            vendas AS (
                SELECT
                    (
                        SUM(CASE WHEN (t.tp_modalidade IN ('4','8') AND t.tp_operacao = 'S') THEN i.qt_solicitada ELSE 0 END)
                        -
                        SUM(CASE WHEN (t.tp_modalidade IN ('3')     AND t.tp_operacao = 'E') THEN i.qt_solicitada ELSE 0 END)
                    )::numeric / 12 AS liquido
                FROM vr_tra_transacao t
                JOIN vr_tra_transitem i
                    ON i.cd_empresa = t.cd_empresa
                   AND i.dt_transacao = t.dt_transacao
                   AND i.nr_transacao = t.nr_transacao
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao <= %s
                  AND t.cd_empresa <> ALL (ARRAY[1::bigint, 120::bigint])
                  AND t.cd_operacao <> ALL (ARRAY[140, 76, 25, 26, 27, 273, 44, 240, 241, 242, 243, 244, 245, 239, 238, 237, 236])
                  AND i.cd_compvend <> 1
                  AND t.tp_situacao <> 6
                  AND (t.tp_modalidade)::text = ANY (ARRAY['2','3','4','8'])
            ),
            estoques AS (
                SELECT SUM(s.estoque)::numeric AS estoque_total
                FROM lojas l
                CROSS JOIN LATERAL (
                    SELECT SUM(
                        f_dic_sld_prd_produto(
                            l.cd_empresa_txt,
                            '1'::text,
                            pg.cd_produto,
                            %s::timestamp
                        )
                    ) AS estoque
                    FROM vr_prd_prdgrade pg
                    WHERE pg.cd_produto < 1000000
                ) s
            )
            SELECT
                NULLIF(e.estoque_total, 0) / NULLIF(v.liquido, 0) AS giro,
                e.estoque_total,
                v.liquido
            FROM vendas v
            CROSS JOIN estoques e
        """, (
            primeiro_dia, ultimo_dia,
            doze_meses_atras, primeiro_dia,
            primeiro_dia,
        ))

        row = result[0] if result else {}
        giro = float(row.get('giro') or 0)
        estoque_total = float(row.get('estoque_total') or 0)
        liquido = float(row.get('liquido') or 0)

        print(f"[OK] Giro Lojas: giro={giro:.4f}, estoque={estoque_total:,.0f}, liquido_medio={liquido:,.0f}")

        return {
            "mes_referencia": mesReferencia,
            "giro": round(giro, 4),
            "estoque_total": estoque_total,
            "venda_liquida_media_mensal": liquido,
            "fonte": "vCenter"
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar giro lojas: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar giro lojas: {str(e)}")


@router.get("/api/indicadores/giro-fabrica")
def get_giro_fabrica(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM)")
):
    """
    Retorna o Giro PA Fábrica (cd_empresa=1) do mês de referência.
    """
    try:
        import calendar

        ano, mes = mesReferencia.split('-')
        primeiro_dia = f"{ano}-{mes}-01"
        ultimo_dia_num = calendar.monthrange(int(ano), int(mes))[1]
        ultimo_dia = f"{ano}-{mes}-{ultimo_dia_num:02d}"
        doze_meses_atras = f"{int(ano) - 1}-{mes}-01"

        try:
            cached = execute_query(
                "SELECT giro, estoque_total, venda_liquida_media FROM mv_giro_fabrica_mensal WHERE mes_referencia = %s",
                (primeiro_dia,)
            )
            if cached:
                row = cached[0]
                giro = float(row.get('giro') or 0)
                print(f"[OK] Giro Fábrica (cache): giro={giro:.4f}")
                return {
                    "mes_referencia": mesReferencia,
                    "giro": round(giro, 4),
                    "estoque_total": float(row.get('estoque_total') or 0),
                    "venda_liquida_media_mensal": float(row.get('venda_liquida_media') or 0),
                    "fonte": "cache"
                }
        except Exception:
            pass

        print(f"[INFO] Giro Fábrica (query pesada): vendas={doze_meses_atras}~{primeiro_dia}, estoque={primeiro_dia}")

        result = execute_query("""
            WITH vendas AS (
                SELECT (
                    SUM(CASE WHEN t.tp_modalidade IN ('4','8') AND t.tp_operacao = 'S' THEN i.qt_solicitada ELSE 0 END)
                    - SUM(CASE WHEN t.tp_modalidade IN ('3') AND t.tp_operacao = 'E' THEN i.qt_solicitada ELSE 0 END)
                )::numeric / 12 AS liquido
                FROM vr_tra_transacao t
                JOIN vr_tra_transitem i
                    ON i.cd_empresa = t.cd_empresa
                   AND i.dt_transacao = t.dt_transacao
                   AND i.nr_transacao = t.nr_transacao
                WHERE t.dt_transacao >= %s
                  AND t.dt_transacao <= %s
                  AND t.cd_empresa = 1
                  AND t.cd_operacao <> ALL (ARRAY[140,76,25,26,27,273,44,240,241,242,243,244,245,239,238,237,236])
                  AND i.cd_compvend <> 1
                  AND t.tp_situacao <> 6
                  AND t.tp_modalidade::text = ANY (ARRAY['2','3','4','8'])
            ),
            estoques AS (
                SELECT SUM(f_dic_sld_prd_produto(
                    '1'::text, '1'::text, pg.cd_produto, %s::timestamp
                )) AS estoque_total
                FROM vr_prd_prdgrade pg
                WHERE pg.cd_produto < 1000000
            )
            SELECT
                NULLIF(e.estoque_total, 0) / NULLIF(v.liquido, 0) AS giro,
                e.estoque_total,
                v.liquido
            FROM vendas v CROSS JOIN estoques e
        """, (doze_meses_atras, primeiro_dia, primeiro_dia))

        row = result[0] if result else {}
        giro = float(row.get('giro') or 0)
        estoque_total = float(row.get('estoque_total') or 0)
        liquido = float(row.get('liquido') or 0)

        print(f"[OK] Giro Fábrica: giro={giro:.4f}, estoque={estoque_total:,.0f}, liquido_medio={liquido:,.0f}")

        return {
            "mes_referencia": mesReferencia,
            "giro": round(giro, 4),
            "estoque_total": estoque_total,
            "venda_liquida_media_mensal": liquido,
            "fonte": "vCenter"
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar giro fábrica: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar giro fábrica: {str(e)}")


@router.get("/api/indicadores/inadimplencia")
def get_inadimplencia(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM)")
):
    """
    Retorna inadimplência em 3 faixas de aging.
    """
    try:
        from datetime import date, timedelta

        ano, mes = mesReferencia.split('-')
        data_base = date(int(ano), int(mes), 1)

        inad30_ini  = data_base - timedelta(days=30)
        inad30_fim  = data_base - timedelta(days=1)
        inad90_ini  = data_base - timedelta(days=90)
        inad90_fim  = data_base - timedelta(days=31)
        inad180_ini = data_base - timedelta(days=180)
        inad180_fim = data_base - timedelta(days=91)

        print(f"[INFO] Inadimplência data_base={data_base}")

        result = execute_query("""
            SELECT
                COALESCE(SUM(CASE WHEN dt_vencimento >= %s AND dt_vencimento <= %s THEN vl_fatura ELSE 0 END), 0) AS inad30_total,
                COALESCE(SUM(CASE WHEN dt_vencimento >= %s AND dt_vencimento <= %s AND tp_baixa = 0 THEN vl_fatura ELSE 0 END), 0) AS inad30_aberto,
                COALESCE(SUM(CASE WHEN dt_vencimento >= %s AND dt_vencimento <= %s THEN vl_fatura ELSE 0 END), 0) AS inad90_total,
                COALESCE(SUM(CASE WHEN dt_vencimento >= %s AND dt_vencimento <= %s AND tp_baixa = 0 THEN vl_fatura ELSE 0 END), 0) AS inad90_aberto,
                COALESCE(SUM(CASE WHEN dt_vencimento >= %s AND dt_vencimento <= %s THEN vl_fatura ELSE 0 END), 0) AS inad180_total,
                COALESCE(SUM(CASE WHEN dt_vencimento >= %s AND dt_vencimento <= %s AND tp_baixa = 0 THEN vl_fatura ELSE 0 END), 0) AS inad180_aberto
            FROM vr_fcr_faturai
            WHERE tp_situacao = 1
              AND tp_documento NOT IN (7, 10, 11)
              AND vl_fatura > 0
              AND dt_vencimento >= %s
              AND dt_vencimento <= %s
        """, (
            inad30_ini,  inad30_fim,
            inad30_ini,  inad30_fim,
            inad90_ini,  inad90_fim,
            inad90_ini,  inad90_fim,
            inad180_ini, inad180_fim,
            inad180_ini, inad180_fim,
            inad180_ini, inad30_fim,
        ))

        row = result[0] if result else {}

        def perc(aberto, total):
            a = float(aberto or 0)
            t = float(total or 0)
            return round(a / t * 100, 2) if t > 0 else 0.0

        inad30_total  = float(row.get('inad30_total', 0))
        inad30_aberto = float(row.get('inad30_aberto', 0))
        inad90_total  = float(row.get('inad90_total', 0))
        inad90_aberto = float(row.get('inad90_aberto', 0))
        inad180_total  = float(row.get('inad180_total', 0))
        inad180_aberto = float(row.get('inad180_aberto', 0))

        return {
            "mes_referencia": mesReferencia,
            "data_base": str(data_base),
            "inad_30": {
                "total_vencido": inad30_total,
                "total_aberto": inad30_aberto,
                "percentual": perc(inad30_aberto, inad30_total),
            },
            "inad_90": {
                "total_vencido": inad90_total,
                "total_aberto": inad90_aberto,
                "percentual": perc(inad90_aberto, inad90_total),
            },
            "inad_180": {
                "total_vencido": inad180_total,
                "total_aberto": inad180_aberto,
                "percentual": perc(inad180_aberto, inad180_total),
            },
            "fonte": "vCenter"
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar inadimplência: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar inadimplência: {str(e)}")


@router.get("/api/indicadores/cmv")
def get_cmv(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM)")
):
    """
    Retorna o CMV (Custo de Mercadorias Vendidas) do mês de referência.
    """
    try:
        import calendar

        ano, mes = mesReferencia.split('-')
        primeiro_dia = f"{ano}-{mes}-01"
        ultimo_dia_num = calendar.monthrange(int(ano), int(mes))[1]
        ultimo_dia = f"{ano}-{mes}-{ultimo_dia_num:02d}"

        print(f"[INFO] Calculando CMV: mês={mesReferencia}")

        result_lojas = execute_query(
            "SELECT COALESCE(SUM(valor), 0) AS total FROM mv_cmv_loja WHERE data >= %s AND data <= %s",
            (primeiro_dia, ultimo_dia)
        )
        cmv_lojas = float(result_lojas[0]['total']) if result_lojas else 0.0

        result_fab = execute_query(
            "SELECT COALESCE(SUM(valor), 0) AS total FROM mv_cmv_fab WHERE data >= %s AND data <= %s",
            (primeiro_dia, ultimo_dia)
        )
        cmv_fab = float(result_fab[0]['total']) if result_fab else 0.0

        cmv_total = abs(cmv_lojas + cmv_fab)

        print(f"[OK] CMV lojas={cmv_lojas:.2f}, fab={cmv_fab:.2f}, total={cmv_total:.2f}")

        return {
            "mes_referencia": mesReferencia,
            "cmv_lojas": abs(cmv_lojas),
            "cmv_fab": abs(cmv_fab),
            "cmv_total": cmv_total,
            "periodo_fab": {
                "data_inicio": primeiro_dia,
                "data_fim": ultimo_dia
            },
            "fonte": "vCenter"
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar CMV: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar CMV: {str(e)}"
        )


@router.get("/api/indicadores/cmv/detalhe")
def get_cmv_detalhe(
    mesReferencia: str = Query("2026-01", description="Mês de referência (YYYY-MM)")
):
    """
    Retorna o CMV detalhado por loja e fábrica para o mês de referência.
    """
    try:
        import calendar

        ano, mes = mesReferencia.split('-')
        primeiro_dia = f"{ano}-{mes}-01"
        ultimo_dia_num = calendar.monthrange(int(ano), int(mes))[1]
        ultimo_dia = f"{ano}-{mes}-{ultimo_dia_num:02d}"

        lojas = execute_query("""
            SELECT
                l.idcentrodecusto AS cd_empresa,
                p.nm_fantasia AS nome,
                ABS(SUM(l.valor)) AS cmv
            FROM mv_cmv_loja l
            JOIN vr_ger_empresa e ON e.cd_empresa = l.idcentrodecusto
            JOIN vr_pes_pessoa p ON p.cd_pessoa = e.cd_pessoa
            WHERE l.data >= %s AND l.data <= %s
            GROUP BY l.idcentrodecusto, p.nm_fantasia
            ORDER BY cmv DESC
        """, (primeiro_dia, ultimo_dia))

        fat_por_empresa = execute_query("""
            SELECT
                t.cd_empresa,
                SUM(CASE WHEN t.tp_modalidade = '4' AND t.tp_operacao = 'S' THEN t.vl_transacao ELSE 0 END)
                - SUM(CASE WHEN t.tp_modalidade = '3' AND t.tp_operacao = 'E' THEN t.vl_transacao ELSE 0 END)
                AS receita_liquida
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.cd_empresa <> 1
            GROUP BY t.cd_empresa
        """, (primeiro_dia, ultimo_dia))

        fat_map = {r['cd_empresa']: float(r['receita_liquida'] or 0) for r in fat_por_empresa}

        fab = execute_query(
            "SELECT ABS(COALESCE(SUM(valor), 0)) AS cmv FROM mv_cmv_fab WHERE data >= %s AND data <= %s",
            (primeiro_dia, ultimo_dia)
        )
        cmv_fab = float(fab[0]['cmv']) if fab else 0.0

        fat_fab = execute_query("""
            SELECT
                SUM(CASE WHEN t.tp_modalidade = '4' AND t.tp_operacao = 'S' THEN t.vl_transacao ELSE 0 END)
                - SUM(CASE WHEN t.tp_modalidade = '3' AND t.tp_operacao = 'E' THEN t.vl_transacao ELSE 0 END)
                AS receita_liquida
            FROM vr_tra_transacao t
            WHERE t.dt_transacao >= %s
              AND t.dt_transacao <= %s
              AND t.tp_situacao = 4
              AND t.cd_empresa = 1
        """, (primeiro_dia, ultimo_dia))
        receita_fab = float(fat_fab[0]['receita_liquida'] or 0) if fat_fab else 0.0

        def perc_cmv(cmv, receita):
            return round(cmv / receita * 100, 2) if receita > 0 else None

        lojas_list = [
            {
                "cd_empresa": r['cd_empresa'],
                "nome": r['nome'],
                "cmv": float(r['cmv']),
                "receita_liquida": fat_map.get(r['cd_empresa'], 0),
                "perc_cmv": perc_cmv(float(r['cmv']), fat_map.get(r['cd_empresa'], 0)),
            }
            for r in lojas
        ]
        cmv_lojas_total = sum(l['cmv'] for l in lojas_list)
        cmv_total = cmv_lojas_total + cmv_fab
        receita_total = sum(l['receita_liquida'] for l in lojas_list) + receita_fab

        return {
            "mes_referencia": mesReferencia,
            "cmv_total": cmv_total,
            "cmv_fab": cmv_fab,
            "receita_fab": receita_fab,
            "perc_cmv_fab": perc_cmv(cmv_fab, receita_fab),
            "receita_total": receita_total,
            "perc_cmv_total": perc_cmv(cmv_total, receita_total),
            "lojas": lojas_list,
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar detalhe CMV: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao buscar detalhe CMV: {str(e)}")


@router.get("/api/indicadores/ciclo-financeiro/historico")
def get_ciclo_financeiro_historico(
    meses: int = Query(12, description="Quantidade de meses para o histórico (padrão: 12)")
):
    """
    Retorna o histórico mensal do PMR, PMP e Ciclo Financeiro.

    Fórmula utilizada:
    - PMR = (Contas a Receber / Faturamento 12 meses) × 360
    - PMP = (Contas a Pagar / Pagamentos 12 meses) × 360
    - Ciclo Operacional = PMR + PME (estoque fixo 31 dias)
    - Ciclo Financeiro = Ciclo Operacional - PMP

    Retorna dados mês a mês para gráficos de linha.
    """
    try:
        import calendar
        from datetime import date, timedelta
        from dateutil.relativedelta import relativedelta

        print(f"[INFO] Calculando histórico de {meses} meses para Ciclo Financeiro")

        # Calcular período
        hoje = date.today()
        mes_atual = date(hoje.year, hoje.month, 1)

        historico = []

        for i in range(meses - 1, -1, -1):
            # Mês de referência (do mais antigo para o mais recente)
            mes_ref = mes_atual - relativedelta(months=i)
            primeiro_dia = mes_ref.strftime('%Y-%m-%d')
            ultimo_dia_num = calendar.monthrange(mes_ref.year, mes_ref.month)[1]
            ultimo_dia = f"{mes_ref.year}-{mes_ref.month:02d}-{ultimo_dia_num:02d}"

            # Nome do mês para exibição
            MESES_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']
            nome_mes = f"{MESES_PT[mes_ref.month - 1]}/{mes_ref.year}"

            # ===== PMR - Prazo Médio de Recebimento =====
            # Fórmula: (Contas a Receber no final do mês / Faturamento 12 meses) × 360

            # Contas a receber em aberto no final do mês
            query_contas_receber = """
                SELECT COALESCE(SUM(vl_fatura), 0) as contas_receber
                FROM vr_fcr_faturai
                WHERE tp_situacao = 1
                  AND dt_emissao <= %s
                  AND (dt_baixa IS NULL OR dt_baixa > %s)
                  AND tp_baixa = 0
                  AND vl_fatura > 0
                  AND tp_documento NOT IN (7, 10, 11)
            """
            resultado_cr = execute_query(query_contas_receber, (ultimo_dia, ultimo_dia))
            contas_receber = float(resultado_cr[0].get('contas_receber', 0)) if resultado_cr else 0

            # Faturamento dos últimos 12 meses até o mês de referência
            data_12m_atras = (mes_ref - relativedelta(months=12)).strftime('%Y-%m-%d')
            query_faturamento = """
                SELECT COALESCE(SUM(vl_fatura), 0) as faturamento_12m
                FROM vr_fcr_faturai
                WHERE dt_emissao >= %s
                  AND dt_emissao <= %s
                  AND tp_situacao = 1
                  AND vl_fatura > 0
                  AND tp_documento NOT IN (7, 10, 11)
            """
            resultado_fat = execute_query(query_faturamento, (data_12m_atras, ultimo_dia))
            faturamento_12m = float(resultado_fat[0].get('faturamento_12m', 0)) if resultado_fat else 0

            # Calcular PMR
            if faturamento_12m > 0:
                pmr_dias = (contas_receber / faturamento_12m) * 360
            else:
                pmr_dias = 0

            # ===== PMP - Prazo Médio de Pagamento =====
            # Fórmula: (Contas a Pagar no final do mês / Pagamentos 12 meses) × 360

            # Contas a pagar em aberto no final do mês
            query_contas_pagar = """
                SELECT COALESCE(SUM(vl_rateio), 0) as contas_pagar
                FROM vr_fcp_despduplicatai
                WHERE tp_situacao = 'N'
                  AND dt_emissao <= %s
                  AND (dt_baixa IS NULL OR dt_baixa > %s)
                  AND vl_rateio > 0
            """
            resultado_cp = execute_query(query_contas_pagar, (ultimo_dia, ultimo_dia))
            contas_pagar = float(resultado_cp[0].get('contas_pagar', 0)) if resultado_cp else 0

            # Pagamentos dos últimos 12 meses até o mês de referência
            query_pagamentos = """
                SELECT COALESCE(SUM(vl_rateio), 0) as pagamentos_12m
                FROM vr_fcp_despduplicatai
                WHERE dt_baixa >= %s
                  AND dt_baixa <= %s
                  AND tp_situacao = 'N'
                  AND vl_rateio > 0
            """
            resultado_pag = execute_query(query_pagamentos, (data_12m_atras, ultimo_dia))
            pagamentos_12m = float(resultado_pag[0].get('pagamentos_12m', 0)) if resultado_pag else 0

            # Calcular PMP
            if pagamentos_12m > 0:
                pmp_dias = (contas_pagar / pagamentos_12m) * 360
            else:
                pmp_dias = 0

            # ===== PME - Prazo Médio de Estocagem (fixo) =====
            pme_dias = 31

            # ===== Ciclos =====
            ciclo_operacional = pmr_dias + pme_dias
            ciclo_financeiro = ciclo_operacional - pmp_dias

            historico.append({
                "mes": nome_mes,
                "mes_ref": mes_ref.strftime('%Y-%m'),
                "pmr_dias": round(pmr_dias, 1),
                "pmp_dias": round(pmp_dias, 1),
                "pme_dias": pme_dias,
                "ciclo_operacional": round(ciclo_operacional, 1),
                "ciclo_financeiro": round(ciclo_financeiro, 1),
                # Dados de base para tooltip/detalhes
                "contas_receber": round(contas_receber, 2),
                "faturamento_12m": round(faturamento_12m, 2),
                "contas_pagar": round(contas_pagar, 2),
                "pagamentos_12m": round(pagamentos_12m, 2),
            })

            print(f"  [{nome_mes}] PMR={pmr_dias:.1f}, PMP={pmp_dias:.1f}, CF={ciclo_financeiro:.1f}")

        # Calcular médias e tendências
        pmr_valores = [h['pmr_dias'] for h in historico]
        pmp_valores = [h['pmp_dias'] for h in historico]
        cf_valores = [h['ciclo_financeiro'] for h in historico]

        resumo = {
            "pmr_media": round(sum(pmr_valores) / len(pmr_valores), 1) if pmr_valores else 0,
            "pmp_media": round(sum(pmp_valores) / len(pmp_valores), 1) if pmp_valores else 0,
            "ciclo_financeiro_media": round(sum(cf_valores) / len(cf_valores), 1) if cf_valores else 0,
            "pmr_min": round(min(pmr_valores), 1) if pmr_valores else 0,
            "pmr_max": round(max(pmr_valores), 1) if pmr_valores else 0,
            "pmp_min": round(min(pmp_valores), 1) if pmp_valores else 0,
            "pmp_max": round(max(pmp_valores), 1) if pmp_valores else 0,
            "ciclo_financeiro_min": round(min(cf_valores), 1) if cf_valores else 0,
            "ciclo_financeiro_max": round(max(cf_valores), 1) if cf_valores else 0,
        }

        # Tendência: comparar média dos últimos 3 meses com os 3 anteriores
        if len(cf_valores) >= 6:
            media_recente = sum(cf_valores[-3:]) / 3
            media_anterior = sum(cf_valores[-6:-3]) / 3
            if media_recente < media_anterior:
                resumo['tendencia'] = 'melhorando'
            elif media_recente > media_anterior:
                resumo['tendencia'] = 'piorando'
            else:
                resumo['tendencia'] = 'estável'
        else:
            resumo['tendencia'] = 'dados insuficientes'

        print(f"[OK] Histórico calculado: {len(historico)} meses, tendência={resumo['tendencia']}")

        return {
            "historico": historico,
            "resumo": resumo,
            "meses_solicitados": meses,
            "fonte": "vCenter"
        }

    except Exception as e:
        print(f"[ERROR] Erro ao calcular histórico ciclo financeiro: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Erro ao calcular histórico: {str(e)}")
