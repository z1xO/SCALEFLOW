'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { streamUrl } from './api';
import type { JobEvent, SystemSnapshot } from './types';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

interface StreamState {
  status: StreamStatus;
  recent: JobEvent[];
  lastEventAt: number | null;
}

const StreamContext = createContext<StreamState>({ status: 'connecting', recent: [], lastEventAt: null });

const MAX_RECENT = 50;

/**
 * One Server-Sent Events connection per open project.
 *
 * Events are hints that make the UI update immediately; the source of truth is always the REST API.
 * - `job`: prepend to the live feed and invalidate the affected queries (throttled).
 * - `ready` after a reconnect, or `reset`: invalidate everything for the project, so whatever
 *   happened while disconnected is re-read from the API (reconciliation).
 * - `system`: queue/worker snapshot, written straight into the query cache.
 * The browser's EventSource resumes with Last-Event-ID on its own; if the connection is closed for
 * good (e.g. API restart behind a load balancer) we reconnect with ?since=<last cursor>.
 */
export function ProjectStreamProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [recent, setRecent] = useState<JobEvent[]>([]);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let readyCount = 0;
    let disposed = false;
    const dirtyJobs = new Set<string>();

    const flush = () => {
      flushTimer = undefined;
      void qc.invalidateQueries({ queryKey: ['jobs', projectId] });
      void qc.invalidateQueries({ queryKey: ['metrics', projectId] });
      void qc.invalidateQueries({ queryKey: ['events', projectId] });
      for (const jobId of dirtyJobs) void qc.invalidateQueries({ queryKey: ['job', projectId, jobId] });
      dirtyJobs.clear();
    };
    const scheduleFlush = () => {
      flushTimer ??= setTimeout(flush, 400);
    };
    const reconcile = () => {
      void qc.invalidateQueries({ predicate: (q) => q.queryKey.includes(projectId) });
    };

    const connect = () => {
      const url = cursorRef.current
        ? `${streamUrl(projectId)}?since=${encodeURIComponent(cursorRef.current)}`
        : streamUrl(projectId);
      es = new EventSource(url, { withCredentials: true });
      es.addEventListener('ready', (e) => {
        const data = JSON.parse((e as MessageEvent<string>).data) as { cursor: string };
        cursorRef.current = data.cursor;
        setStatus('live');
        readyCount += 1;
        if (readyCount > 1) reconcile(); // a reconnect: re-read anything that may have changed meanwhile
      });
      es.addEventListener('job', (e) => {
        const msg = e as MessageEvent<string>;
        const event = JSON.parse(msg.data) as JobEvent;
        cursorRef.current = event.cursor;
        setLastEventAt(Date.now());
        setRecent((prev) => [event, ...prev.filter((p) => p.cursor !== event.cursor)].slice(0, MAX_RECENT));
        dirtyJobs.add(event.jobId);
        scheduleFlush();
      });
      es.addEventListener('reset', () => {
        reconcile();
      });
      es.addEventListener('system', (e) => {
        qc.setQueryData(['system', 'queues'], JSON.parse((e as MessageEvent<string>).data) as SystemSnapshot);
      });
      es.onerror = () => {
        if (!es || disposed) return;
        if (es.readyState === EventSource.CLOSED) {
          setStatus('offline');
          es.close();
          retryTimer = setTimeout(connect, 5_000);
        } else {
          setStatus('reconnecting');
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      es?.close();
      clearTimeout(retryTimer);
      clearTimeout(flushTimer);
    };
  }, [projectId, qc]);

  return <StreamContext.Provider value={{ status, recent, lastEventAt }}>{children}</StreamContext.Provider>;
}

export function useStream(): StreamState {
  return useContext(StreamContext);
}
