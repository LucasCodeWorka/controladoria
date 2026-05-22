from fastapi import APIRouter, HTTPException
from datetime import datetime
import services

router = APIRouter()


@router.get("/")
def read_root():
    """Endpoint raiz"""
    return {
        "message": "DFC API - Backend Python/FastAPI",
        "version": "1.0.0",
        "endpoints": {
            "/api/dfc": "Buscar dados do DFC",
            "/api/health": "Health check"
        }
    }


@router.get("/api/health")
def health_check():
    """Health check endpoint"""
    return {
        "status": "ok",
        "timestamp": datetime.now().isoformat()
    }


@router.get("/centros-custo")
def get_centros_custo():
    """
    Retorna lista de centros de custo disponíveis

    Returns:
        JSON com lista de centros de custo
    """
    try:
        print("[INFO] Buscando centros de custo...")
        centros = services.fetch_centros_custo()
        print(f"[OK] {len(centros)} centros de custo encontrados.")
        return {
            "centros": centros,
            "total": len(centros)
        }
    except Exception as e:
        print(f"[ERROR] Erro ao buscar centros de custo: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao buscar centros de custo: {str(e)}"
        )
