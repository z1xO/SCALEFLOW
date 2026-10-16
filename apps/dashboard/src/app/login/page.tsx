'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === 'register') await api.register(email, password, name);
      await api.login(email, password);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      router.replace('/projects');
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  const error = submit.error instanceof ApiError ? submit.error : null;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6">
        <h1 className="text-xl font-semibold">ScaleFlow</h1>
        <p className="mt-1 text-sm text-muted">
          {mode === 'login' ? 'Sign in to your dashboard' : 'Create an account'}
        </p>
        <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit} noValidate={false}>
          {mode === 'register' && (
            <Field label="Name">
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                />
              )}
            </Field>
          )}
          <Field label="Email">
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            )}
          </Field>
          <Field label="Password" hint={mode === 'register' ? 'At least 10 characters.' : undefined}>
            {(id) => (
              <Input
                id={id}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === 'register' ? 10 : 1}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            )}
          </Field>
          {submit.error && (
            <Notice tone="error">
              {error?.code === 'validation_failed'
                ? 'Please check the form: email must be valid and the password at least 10 characters.'
                : submit.error.message}
            </Notice>
          )}
          <Button type="submit" variant="primary" busy={submit.isPending}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>
        <p className="mt-4 text-sm text-muted">
          {mode === 'login' ? 'No account yet? ' : 'Already have an account? '}
          <button
            type="button"
            className="font-medium text-accent underline-offset-2 hover:underline"
            onClick={() => {
              submit.reset();
              setMode(mode === 'login' ? 'register' : 'login');
            }}
          >
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </button>
        </p>
        <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
          Development authentication: email + password with an HttpOnly session cookie. See docs/security.md
          for what production deployments should add (SSO, MFA).
        </p>
      </div>
    </main>
  );
}
