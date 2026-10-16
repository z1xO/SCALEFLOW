'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button, Card, Field, Input, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { RequireAuth, useMe } from '@/lib/auth';
import { relativeTime } from '@/lib/format';

function Projects() {
  const qc = useQueryClient();
  const router = useRouter();
  const me = useMe();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.createProject(name.trim()),
    onSuccess: async ({ project }) => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['projects'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
      router.push(`/projects/${project.id}`);
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-muted">Signed in as {me.data?.user.email}</p>
        </div>
      </div>
      <Card title="Your projects">
        {projects.isPending ? (
          <LoadingRows rows={3} />
        ) : projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        ) : projects.data.items.length === 0 ? (
          <EmptyState title="No projects yet">Create your first project below to get an API key and submit jobs.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {projects.data.items.map((p) => (
              <li key={p.id} className="flex items-center justify-between py-2.5">
                <Link href={`/projects/${p.id}`} className="font-medium text-accent hover:underline">
                  {p.name}
                </Link>
                <span className="text-xs text-muted">
                  {p.role} · created {relativeTime(p.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Create a project">
        <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Project name">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />}
            </Field>
          </div>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={!name.trim()}>
            Create project
          </Button>
        </form>
        {create.error && (
          <div className="mt-3">
            <Notice tone="error">{create.error.message}</Notice>
          </div>
        )}
      </Card>
    </main>
  );
}

export default function ProjectsPage() {
  return (
    <RequireAuth>
      <Projects />
    </RequireAuth>
  );
}
