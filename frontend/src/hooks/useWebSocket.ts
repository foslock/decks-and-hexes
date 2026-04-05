import { useEffect, useRef, useState, useCallback } from 'react';

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

interface UseWebSocketResult {
  lastMessage: WsMessage | null;
  status: WsStatus;
  reconnect: () => void;
}

const MAX_RETRIES = 3;
const BASE_DELAY = 1000; // 1s, 2s, 4s

export function useWebSocket(
  code: string | null,
  playerId: string | null,
  token: string | null,
): UseWebSocketResult {
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);
  const [status, setStatus] = useState<WsStatus>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const closedIntentionallyRef = useRef(false);

  const connect = useCallback(() => {
    if (!code || !playerId || !token) return;

    closedIntentionallyRef.current = false;
    setStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/api/lobby/ws/${code}?player_id=${playerId}&token=${token}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      retriesRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsMessage;
        setLastMessage(data);
      } catch {
        // Ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (closedIntentionallyRef.current) {
        setStatus('disconnected');
        return;
      }
      // Auto-reconnect with exponential backoff
      if (retriesRef.current < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retriesRef.current);
        retriesRef.current += 1;
        setStatus('connecting');
        setTimeout(() => connect(), delay);
      } else {
        setStatus('error');
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }, [code, playerId, token]);

  const reconnect = useCallback(() => {
    retriesRef.current = 0;
    if (wsRef.current) {
      closedIntentionallyRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      closedIntentionallyRef.current = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { lastMessage, status, reconnect };
}
