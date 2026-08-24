from fastapi import APIRouter
from datetime import datetime

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


