declare module '@lancedb/lancedb' {
  export type Table = {
    delete: (filter: string) => Promise<void>;
    createIndex: (column: string, options: { config: unknown }) => Promise<void>;
    query: () => {
      where: (clause: string) => any;
      limit: (n: number) => any;
      toArray: () => Promise<any[]>;
    };
    add: (rows: Record<string, unknown>[]) => Promise<void>;
    update: (options: { where: string; values: Record<string, unknown> }) => Promise<void>;
    search: (query: string) => {
      limit: (n: number) => any;
      toArray: () => Promise<any[]>;
    };
    vectorSearch: (vector: number[]) => {
      limit: (n: number) => any;
      toArray: () => Promise<any[]>;
    };
  };

  export type Connection = {
    tableNames: () => Promise<string[]>;
    openTable: (name: string) => Promise<Table>;
    createTable: (name: string, rows: Record<string, unknown>[]) => Promise<Table>;
    dropTable: (name: string) => Promise<void>;
  };

  export const Index: {
    fts: () => unknown;
  };

  export function connect(path: string): Promise<Connection>;
}
