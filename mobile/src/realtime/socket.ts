import { io, Socket } from 'socket.io-client';

export function createSocket(baseUrl: string, token: string): Socket {
  return io(baseUrl, { auth: { token } });
}
