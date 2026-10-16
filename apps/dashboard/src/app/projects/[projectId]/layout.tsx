'use client';

import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { ProjectShell } from '@/components/shell';
import { RequireAuth } from '@/lib/auth';
import { ProjectStreamProvider } from '@/lib/stream';

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <RequireAuth>
      <ProjectStreamProvider projectId={projectId}>
        <ProjectShell projectId={projectId}>{children}</ProjectShell>
      </ProjectStreamProvider>
    </RequireAuth>
  );
}
