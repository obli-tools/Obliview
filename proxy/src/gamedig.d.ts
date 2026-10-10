declare module 'gamedig' {
  interface QueryResult {
    name: string;
    map: string;
    password: boolean;
    numplayers: number;
    maxplayers: number;
    players: unknown[];
    bots: unknown[];
    connect: string;
    ping: number;
  }
  export class GameDig {
    static query(options: {
      type: string;
      host: string;
      port?: number;
      maxRetries?: number;
      socketTimeout?: number;
    }): Promise<QueryResult>;
  }
}
