'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login } = useAuth();
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (login(username, password)) {
      router.push('/');
    } else {
      setError('Usuário ou senha inválidos');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-primary to-brand-secondary flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl p-8">
        {/* Título Principal */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-light text-brand-dark tracking-wide font-secondary">
            LIEBE CONTROLADORIA
          </h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label
              htmlFor="username"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              Usuário
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-transparent outline-none transition"
              placeholder="Digite seu usuário"
              required
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              Senha
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-primary focus:border-transparent outline-none transition"
              placeholder="Digite sua senha"
              required
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="w-full bg-brand-primary text-white py-3 rounded-lg hover:bg-brand-secondary transition-colors font-semibold shadow-lg hover:shadow-xl"
          >
            Entrar
          </button>
        </form>

        {/* Logos no Rodapé */}
        <div className="mt-8 mb-4">
          <div className="flex items-center justify-center gap-6">
            {/* Logo Grupo Cairo Benevides */}
            <div className="flex-shrink-0">
              <div className="bg-black px-6 py-3 rounded-lg">
                <div className="text-white text-center font-secondary">
                  <div className="text-[9px] tracking-[0.25em] font-light uppercase">Grupo</div>
                  <div className="text-sm font-bold tracking-wide">CAIRO BENEVIDES</div>
                </div>
              </div>
            </div>

            {/* Logo Liebe */}
            <div className="flex-shrink-0">
              <div className="bg-brand-primary px-8 py-3 rounded-lg">
                <div className="text-white text-xl font-bold tracking-[0.15em] font-secondary">LIEBE</div>
              </div>
            </div>
          </div>
        </div>

        <div className="text-center">
          <a
            href="https://www.liebelingerie.com.br/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-brand-primary hover:text-brand-secondary transition-colors underline font-secondary"
          >
            www.liebelingerie.com.br
          </a>
        </div>
      </div>
    </div>
  );
}
