import { useCallback, useEffect, useRef, useState } from 'react';
import { getJob } from '../api.js';
import { artifactsOf, isTerminal } from '../model.js';

const MAX_RETRIES = 6;
const MAX_EVENTS = 300;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

export function applyEvent(job, event) {
  const payload = event.payload || {};
  const current = job || { id: event.job_id, state: 'UNKNOWN', metrics: {}, artifacts: [] };
  switch (event.type) {
    case 'SNAPSHOT':
      if (!payload.job || typeof payload.job !== 'object') return current;
      return {
        ...current, ...payload.job,
        metrics: { ...current.metrics, ...payload.job.metrics },
        artifacts: payload.job.artifacts ?? current.artifacts,
      };
    case 'STATE_TRANSITION':
      return { ...current, state: payload.state ?? current.state, agent: payload.agent ?? current.agent };
    case 'METRICS': {
      const metrics = { ...current.metrics, ...payload };
      // Replayed audit verdicts must not overwrite a newer credit verdict.
      if (typeof payload.passed === 'boolean' && !('default_probability' in payload) &&
          current.metrics?.default_probability != null) metrics.passed = current.metrics.passed;
      return { ...current, metrics };
    }
    case 'ROLLBACK_TRIGGERED':
      return {
        ...current,
        rollback: payload,
        metrics: { ...current.metrics, ...(payload.variance != null ? { variance: payload.variance } : {}) },
      };
    case 'ARTIFACT_GENERATED': {
      if (typeof payload.name !== 'string' || typeof payload.url !== 'string') return current;
      const artifacts = artifactsOf(current.artifacts).filter((item) => item.url !== payload.url);
      return { ...current, artifacts: [...artifacts, { name: payload.name, url: payload.url }] };
    }
    default:
      return current;
  }
}

export default function useAgentStream(run, apiKey) {
  const jobId = run?.job_id;
  const token = run?.stream_token;
  const [job, setJob] = useState(null);
  const [scope, setScope] = useState(null);
  const [events, setEvents] = useState([]);
  const [connection, setConnection] = useState({ status: 'idle', attempts: 0, delay: 0 });
  const [error, setError] = useState('');
  const [sequence, setSequence] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const refreshRef = useRef(null);
  const checkpointRef = useRef(null);
  const reconnect = useCallback(() => setRetryNonce((value) => value + 1), []);
  const refresh = useCallback(() => refreshRef.current?.(), []);

  useEffect(() => {
    let disposed = false;
    let socket = null;
    let timer = null;
    let attempts = 0;
    const prior = checkpointRef.current;
    // Manual reconnect keeps the replay cursor in memory; changing credentials
    // or selecting another run discards cached protected evidence.
    const resume = prior?.jobId === jobId && prior?.token === token && prior?.apiKey === apiKey;
    let lastSequence = resume ? prior.sequence : 0;
    let terminal = false;
    let currentJob = resume ? prior.job : null;
    let bufferedEvents = resume ? prior.events : [];
    let snapshotPromise = null;
    let finalSnapshotRequested = false;
    const controller = new AbortController();
    setScope({ jobId, token, apiKey });
    setJob(currentJob);
    setEvents(bufferedEvents);
    setError('');
    setSequence(lastSequence);
    setConnection({ status: jobId ? 'connecting' : 'idle', attempts: 0, delay: 0 });

    function updateConnection(status, delay = 0) {
      if (!disposed) setConnection({ status, attempts, delay });
    }

    function commit(next) {
      currentJob = next;
      if (!disposed) setJob(next);
    }

    function stopForTerminal() {
      terminal = true;
      window.clearTimeout(timer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      updateConnection('complete');
    }

    async function fetchSnapshot(forceFinal = false) {
      // A terminal event can arrive while an older GET is in flight. Wait for it,
      // then issue a fresh GET instead of treating the pre-terminal request as final.
      if (snapshotPromise) {
        await snapshotPromise;
        if (disposed) return null;
        if (!forceFinal) return currentJob;
      }
      const requestSequence = lastSequence;
      snapshotPromise = (async () => {
        try {
          const snapshot = await getJob(jobId, apiKey, controller.signal);
          if (disposed) return null;
          if (!snapshot || snapshot.id !== jobId || typeof snapshot.state !== 'string') {
            throw new Error('The job snapshot does not match the requested run.');
          }
          // Replay events received during the request; an older snapshot must not
          // overwrite a newer streamed metric or state. Terminal GETs are authoritative.
          const newerEvents = bufferedEvents.filter((event) => event.seq > requestSequence);
          const next = forceFinal ? { ...currentJob, ...snapshot } : newerEvents.reduce(applyEvent, {
            ...currentJob, ...snapshot,
            metrics: { ...currentJob?.metrics, ...snapshot.metrics },
          });
          commit(next);
          setError('');
          // A terminal REST snapshot must not prevent replay of the actual
          // historical events. Stop only after the terminal event was received,
          // or when the caller has no scoped stream token.
          if (isTerminal(next.state) && (forceFinal || !token || bufferedEvents.some((event) =>
            event.type === 'STATE_TRANSITION' && isTerminal(event.payload?.state)))) stopForTerminal();
          return next;
        } catch (reason) {
          if (!disposed && reason.name !== 'AbortError') setError(reason.message);
          return null;
        }
      })();
      const pending = snapshotPromise;
      await pending;
      if (snapshotPromise === pending) snapshotPromise = null;
      return currentJob;
    }

    function requestFinalSnapshot() {
      if (finalSnapshotRequested) return;
      finalSnapshotRequested = true;
      stopForTerminal();
      void fetchSnapshot(true).then(() => {
        // A failed final fetch remains visible and can be retried manually.
        finalSnapshotRequested = false;
      });
    }

    async function scheduleReconnect() {
      if (disposed || terminal) return;
      updateConnection('reconnecting');
      // Always reconcile the job after a disconnect before reconnecting the stream.
      await fetchSnapshot();
      if (disposed || terminal) return;
      if (attempts >= MAX_RETRIES) {
        updateConnection('exhausted');
        setError('Stream retries exhausted. Refresh the snapshot or retry the connection.');
        return;
      }
      const delay = Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
      attempts += 1;
      updateConnection('reconnecting', delay);
      timer = window.setTimeout(connect, delay);
    }

    function connect() {
      if (disposed || terminal) return;
      updateConnection('connecting');
      const url = new URL('/api/v2/agent-stream', window.location.origin);
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('job_id', jobId);
      url.searchParams.set('token', token);
      url.searchParams.set('after', String(lastSequence));
      try {
        // Adaptation of the documented SDK chat-demo streaming pattern: a React
        // effect owns the connection, incremental events update state, and cleanup
        // closes the transport. This backend uses native WebSocket, NOT a fabricated
        // codebuddy-chat-web npm client. Browser WS cannot attach X-API-Key headers;
        // the POST-issued stream_token authenticates this job-scoped connection.
        socket = new WebSocket(url);
      } catch {
        void scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        if (disposed) return;
        updateConnection('connected');
        setError('');
        void fetchSnapshot();
      };
      socket.onmessage = (message) => {
        if (disposed || terminal) return;
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          setError('An invalid stream message was ignored.');
          return;
        }
        if (!event || event.job_id !== jobId || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
          typeof event.type !== 'string' || event.seq <= lastSequence) return;
        const previousSequence = lastSequence;
        lastSequence = event.seq;
        setSequence(lastSequence);
        if (event.type !== 'HEARTBEAT') {
          bufferedEvents = [...bufferedEvents, event].slice(-MAX_EVENTS);
          setEvents(bufferedEvents);
          commit(applyEvent(currentJob, event));
        }
        // Missing/replayed history is recovered by the authoritative REST snapshot.
        if (event.seq > previousSequence + 1) void fetchSnapshot();
        if (event.type === 'STATE_TRANSITION' && isTerminal(event.payload?.state)) requestFinalSnapshot();
      };
      socket.onerror = () => {
        if (!disposed) setError('The stream was interrupted. Reconnecting with the last sequence.');
        // onclose owns the retry timer, preventing duplicate retry loops.
        socket.close();
      };
      socket.onclose = () => void scheduleReconnect();
    }

    refreshRef.current = () => fetchSnapshot(terminal);
    if (jobId) {
      void fetchSnapshot().then(() => {
        if (disposed || terminal) return;
        if (token) connect();
        else updateConnection('snapshot-only');
      });
    }
    return () => {
      checkpointRef.current = { jobId, token, apiKey, sequence: lastSequence, job: currentJob, events: bufferedEvents };
      disposed = true;
      refreshRef.current = null;
      controller.abort();
      window.clearTimeout(timer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [jobId, token, apiKey, retryNonce]);

  const scopeMatches = scope?.jobId === jobId && scope?.token === token && scope?.apiKey === apiKey;
  return {
    job: scopeMatches ? job : null,
    events: scopeMatches ? events : [],
    connection: scopeMatches ? connection : { status: jobId ? 'connecting' : 'idle', attempts: 0, delay: 0 },
    error: scopeMatches ? error : '',
    sequence: scopeMatches ? sequence : 0,
    reconnect, refresh,
  };
}
