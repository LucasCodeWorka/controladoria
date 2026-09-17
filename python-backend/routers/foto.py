"""
Foto de produto por referencia - consulta a API publica da loja
(liebelingerie.com.br, VTEX) e cacheia em memoria, pro tooltip de foto ao
passar o mouse numa referencia (CMV Detalhado, e reaproveitavel em
qualquer outra tela que tenha coluna de referencia).

A API da VTEX e publica/sem autenticacao, mas so pode ser chamada do
BACKEND - direto do navegador da CORS. Busca por codigo de referencia
(alternateIds_RefId), devolve um array (vazio quando nao acha - produto
fora do site, descontinuado, ou codigo interno/materia-prima que nunca
teve pagina).
"""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

_REF_VALIDA = re.compile(r"^[A-Za-z0-9._-]{1,20}$")
_TTL_SEGUNDOS = 24 * 60 * 60  # foto de produto quase nunca muda
_TIMEOUT_SEGUNDOS = 5  # loja lenta/fora do ar nao pode travar nossa tela

# ref -> (url ou None, timestamp do cache) - cacheia o None tambem, senao
# toda referencia sem foto (materia-prima, codigo interno) refaz a
# consulta a cada passada de mouse.
_cache_foto: dict = {}


def _redimensionar(url: str) -> str:
    """A VTEX devolve a imagem original em alta resolucao (.../ids/{id}-
    {largura}-{altura}/arquivo.jpg) - troca pra uma versao ja redimensionada
    (320px), deixando o primeiro carregamento do tooltip mais leve. So
    mexe quando a URL bate exatamente com esse padrao; caso contrario
    devolve sem alterar (mais seguro que forcar e quebrar a URL)."""
    return re.sub(r"-\d+-\d+/(?=[^/]+$)", "-320-auto/", url, count=1)


@router.get("/api/foto")
def buscar_foto(ref: str = Query(..., description="Codigo de referencia do produto")):
    ref = ref.strip()
    if not _REF_VALIDA.match(ref):
        raise HTTPException(status_code=400, detail="ref invalida")

    agora = time.time()
    em_cache = _cache_foto.get(ref)
    if em_cache and (agora - em_cache[1]) < _TTL_SEGUNDOS:
        return {"url": em_cache[0]}

    url_foto = None
    try:
        url_busca = (
            "https://www.liebelingerie.com.br/api/catalog_system/pub/products/search"
            f"?fq=alternateIds_RefId:{urllib.parse.quote(ref)}"
        )
        req = urllib.request.Request(url_busca, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SEGUNDOS) as resp:
            dados = json.loads(resp.read().decode("utf-8"))
        if dados:
            itens = dados[0].get("items") or []
            imagens = itens[0].get("images") if itens else []
            if imagens:
                bruta = imagens[0].get("imageUrl")
                if bruta:
                    url_foto = _redimensionar(bruta)
    except Exception as e:
        print(f"[FOTO] Indisponivel pra ref '{ref}': {e}")

    _cache_foto[ref] = (url_foto, agora)
    return {"url": url_foto}
