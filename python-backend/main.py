from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import close_all_connections

from routers import health, indicadores, dre, classificacao

app = FastAPI(
    title="Liebe DRE API",
    description="API para DRE e Indicadores - Liebe Controladoria",
    version="1.0.0"
)

import os

# Configurar CORS - aceitar localhost e domínios do Render
cors_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
]

# Adicionar domínio do frontend no Render (variável de ambiente)
frontend_url = os.getenv("FRONTEND_URL")
if frontend_url:
    cors_origins.append(frontend_url)

# Adicionar qualquer domínio .onrender.com
cors_origins.append("https://*.onrender.com")

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_origin_regex=r"https://.*\.onrender\.com",
)

app.include_router(health.router)
app.include_router(dre.router)
app.include_router(indicadores.router)
app.include_router(classificacao.router)


@app.on_event("shutdown")
def shutdown_event():
    print("[INFO] Fechando conexoes com banco de dados...")
    close_all_connections()


if __name__ == "__main__":
    import uvicorn
    import os
    import sys

    if sys.platform == 'win32':
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

    port = int(os.getenv('API_PORT', '8000'))
    host = os.getenv('API_HOST', '0.0.0.0')

    print(f"[START] Iniciando servidor FastAPI em http://{host}:{port}")
    uvicorn.run(
        app,
        host=host,
        port=port,
        timeout_keep_alive=300,
        timeout_graceful_shutdown=300,
    )
