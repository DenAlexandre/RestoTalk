import {
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OnEvent } from '@nestjs/event-emitter';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { SessionTokenPayload } from '../sessions/session-auth.guard';

@WebSocketGateway({ cors: true })
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly tablesService: TablesService,
  ) {}

  // Auth must run as a Socket.io middleware (not in handleConnection): by the
  // time handleConnection fires, the handshake has already completed and the
  // client has already received its 'connect' event. Rejecting from inside
  // handleConnection via client.disconnect() would surface as a 'disconnect'
  // on the client, not a 'connect_error'. Running the same JWT + DB
  // active-session check (mirroring SessionAuthGuard) inside server.use()
  // lets us call next(error) before the handshake completes, so an
  // unauthenticated client correctly sees 'connect_error' and never connects.
  afterInit(server: Server) {
    server.use((socket: Socket, next: (err?: Error) => void) => {
      void this.authenticate(socket, next);
    });
  }

  private async authenticate(socket: Socket, next: (err?: Error) => void) {
    const token = socket.handshake.auth?.token as string | undefined;

    if (!token) {
      next(new Error('Unauthorized'));
      return;
    }

    try {
      const payload = this.jwtService.verify<SessionTokenPayload>(token);
      const session = await this.prisma.clientSession.findUnique({
        where: { id: payload.sub },
      });

      if (!session || session.status !== 'active') {
        next(new Error('Unauthorized'));
        return;
      }

      socket.data.tableId = session.tableId;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  }

  @OnEvent('table.presence.changed')
  async handlePresenceChanged() {
    const occupied = await this.tablesService.listOccupied();
    this.server.emit('tables:update', occupied);
  }
}
