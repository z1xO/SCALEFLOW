'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { PageHeader } from '@/components/shell';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button, Card, Dialog, Field, Input, Notice, Select } from '@/components/ui';
import { api, API_URL, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { relativeTime } from '@/lib/format';
import type { ApiKey, Role } from '@/lib/types';

function SecretDialog({
  secret,
  onClose,
  projectId,
}: {
  secret: string | null;
  onClose: () => void;
  projectId: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={secret !== null} onClose={onClose} title="Your new API key">
      <div className="flex flex-col gap-3">
        <Notice tone="info">
          This is the only time the key is shown. Only a hash is stored on the server.
        </Notice>
        <code
          data-testid="api-key-secret"
          className="break-all rounded-md border border-line bg-surface-2 p-3 font-mono text-sm"
        >
          {secret}
        </code>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => {
              if (secret) void navigator.clipboard.writeText(secret).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy key'}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
        <p className="text-xs text-muted">Try it:</p>
        <pre className="overflow-x-auto rounded-md bg-surface-2 p-2 font-mono text-xs">
          {`curl -X POST ${API_URL}/v1/projects/${projectId}/jobs \\
  -H "Authorization: Bearer ${secret ?? '<key>'}" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"demo.echo","payload":{"message":"hi"}}'`}
        </pre>
      </div>
    </Dialog>
  );
}

export default function SettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const qc = useQueryClient();
  const me = useMe();
  const role = me.data?.memberships.find((m) => m.projectId === projectId)?.role;
  const isOwner = role === 'owner';
  const keys = useQuery({
    queryKey: ['api-keys', projectId],
    queryFn: () => api.apiKeys(projectId),
    enabled: isOwner,
  });
  const members = useQuery({ queryKey: ['members', projectId], queryFn: () => api.members(projectId) });

  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [scope, setScope] = useState<'rw' | 'r'>('rw');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<Role>('developer');

  const refreshKeys = () => qc.invalidateQueries({ queryKey: ['api-keys', projectId] });
  const onErr = (e: Error) => setError(e instanceof ApiError ? `${e.message} (${e.code})` : e.message);

  const createKey = useMutation({
    mutationFn: () =>
      api.createApiKey(
        projectId,
        keyName.trim(),
        scope === 'rw' ? ['jobs:read', 'jobs:write'] : ['jobs:read'],
      ),
    onSuccess: async (r) => {
      setKeyName('');
      setSecret(r.secret);
      await refreshKeys();
    },
    onError: onErr,
  });
  const rotate = useMutation({
    mutationFn: (k: ApiKey) => api.rotateApiKey(projectId, k.id, 3600),
    onSuccess: async (r) => {
      setSecret(r.secret);
      await refreshKeys();
    },
    onError: onErr,
  });
  const revoke = useMutation({
    mutationFn: (k: ApiKey) => api.revokeApiKey(projectId, k.id),
    onSuccess: refreshKeys,
    onError: onErr,
  });
  const addMember = useMutation({
    mutationFn: () => api.addMember(projectId, memberEmail.trim(), memberRole),
    onSuccess: async () => {
      setMemberEmail('');
      await qc.invalidateQueries({ queryKey: ['members', projectId] });
    },
    onError: onErr,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.removeMember(projectId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members', projectId] }),
    onError: onErr,
  });

  return (
    <>
      <PageHeader title="API keys & members" description={`Project id: ${projectId}`} />
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      <div className="flex flex-col gap-5">
        <Card title="API keys">
          {!isOwner ? (
            <p className="text-sm text-muted">Only project owners can manage API keys.</p>
          ) : (
            <div className="flex flex-col gap-4">
              <form
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  setError(null);
                  createKey.mutate();
                }}
              >
                <div className="flex-1">
                  <Field label="Key name">
                    {(id) => (
                      <Input
                        id={id}
                        value={keyName}
                        onChange={(e) => setKeyName(e.target.value)}
                        placeholder="e.g. backend-prod"
                        required
                      />
                    )}
                  </Field>
                </div>
                <Field label="Scopes">
                  {(id) => (
                    <Select id={id} value={scope} onChange={(e) => setScope(e.target.value as 'rw' | 'r')}>
                      <option value="rw">Read & write jobs</option>
                      <option value="r">Read only</option>
                    </Select>
                  )}
                </Field>
                <Button type="submit" variant="primary" busy={createKey.isPending} disabled={!keyName.trim()}>
                  Create key
                </Button>
              </form>
              {keys.isPending ? (
                <LoadingRows rows={2} />
              ) : keys.isError ? (
                <ErrorState error={keys.error} />
              ) : keys.data.items.length === 0 ? (
                <EmptyState title="No API keys">Create a key to submit jobs from your services.</EmptyState>
              ) : (
                <ul className="divide-y divide-line">
                  {keys.data.items.map((k) => {
                    const expired =
                      k.expiresAt !== null && new Date(k.expiresAt).getTime() < keys.dataUpdatedAt;
                    const inactive = k.revokedAt !== null || expired;
                    return (
                      <li
                        key={k.id}
                        className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div>
                          <p className="font-medium">
                            {k.name} <span className="font-mono text-xs text-muted">{k.prefix}…</span>
                          </p>
                          <p className="text-xs text-muted">
                            {k.scopes.join(', ')} · created {relativeTime(k.createdAt)} · last used{' '}
                            {k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'never'}
                            {k.revokedAt && ` · revoked ${relativeTime(k.revokedAt)}`}
                            {!k.revokedAt &&
                              k.expiresAt &&
                              ` · ${expired ? 'expired' : 'expires'} ${relativeTime(k.expiresAt)}`}
                          </p>
                        </div>
                        {!inactive && (
                          <div className="flex gap-2">
                            <Button
                              onClick={() => rotate.mutate(k)}
                              busy={rotate.isPending && rotate.variables.id === k.id}
                            >
                              Rotate
                            </Button>
                            <Button
                              variant="danger"
                              onClick={() => revoke.mutate(k)}
                              aria-label={`Revoke key ${k.name}`}
                            >
                              Revoke
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-xs text-muted">
                Rotation issues a new key and keeps the old one valid for one hour.
              </p>
            </div>
          )}
        </Card>
        <Card title="Members">
          {members.isPending ? (
            <LoadingRows rows={2} />
          ) : members.isError ? (
            <ErrorState error={members.error} />
          ) : (
            <ul className="divide-y divide-line">
              {members.data.items.map((m) => (
                <li key={m.userId} className="flex items-center justify-between py-2.5 text-sm">
                  <span>
                    {m.name} <span className="text-muted">{m.email}</span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-ink-2">{m.role}</span>
                    {isOwner && m.userId !== me.data?.user.id && (
                      <Button
                        variant="danger"
                        onClick={() => removeMember.mutate(m.userId)}
                        aria-label={`Remove ${m.email}`}
                      >
                        Remove
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {isOwner && (
            <form
              className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                setError(null);
                addMember.mutate();
              }}
            >
              <div className="flex-1">
                <Field label="Add member by email" hint="The user must already have an account.">
                  {(id) => (
                    <Input
                      id={id}
                      type="email"
                      value={memberEmail}
                      onChange={(e) => setMemberEmail(e.target.value)}
                      required
                    />
                  )}
                </Field>
              </div>
              <Field label="Role">
                {(id) => (
                  <Select id={id} value={memberRole} onChange={(e) => setMemberRole(e.target.value as Role)}>
                    <option value="developer">Developer</option>
                    <option value="viewer">Viewer</option>
                    <option value="owner">Owner</option>
                  </Select>
                )}
              </Field>
              <Button type="submit" busy={addMember.isPending}>
                Add member
              </Button>
            </form>
          )}
        </Card>
      </div>
      <SecretDialog secret={secret} onClose={() => setSecret(null)} projectId={projectId} />
    </>
  );
}
