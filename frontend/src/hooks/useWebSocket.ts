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
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset lastMessage when connection parameters change to prevent stale messages
  // from a previous session being processed by a new one
  const prevCodeRef = useRef(code);
  if (code !== prevCodeRef.current) {
    prevCodeRef.current = code;
    setLastMessage(null);
  }

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

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
        setLastMessage(null); // Clear stale messages on intentional disconnect
        return;
      }
      // Auto-reconnect with exponential backoff
      if (retriesRef.current < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retriesRef.current);
        retriesRef.current += 1;
        setStatus('connecting');
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
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
    clearReconnectTimer();
    if (wsRef.current) {
      closedIntentionallyRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }
    connect();
  }, [connect, clearReconnectTimer]);

  useEffect(() => {
    connect();
    return () => {
      closedIntentionallyRef.current = true;
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, clearReconnectTimer]);

  return { lastMessage, status, reconnect };
}
