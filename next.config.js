/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // Em desenvolvimento ou quando PYTHON_API_URL estiver definido (ex: Render),
    // redireciona /api/* para o backend Python
    const backendUrl = process.env.PYTHON_API_URL || 'http://127.0.0.1:8000';
    if (process.env.NODE_ENV === 'development' || process.env.PYTHON_API_URL) {
      return [
        {
          source: '/api/:path*',
          destination: `${backendUrl}/api/:path*`,
        },
      ];
    }
    return [];
  },
  experimental: {
    proxyTimeout: 300000, // 5 minutos
  },
  serverRuntimeConfig: {
    timeout: 300000, // 5 minutos
  },
}

module.exports = nextConfig
