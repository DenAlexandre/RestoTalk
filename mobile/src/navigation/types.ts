export type RootStackParamList = {
  Scan: undefined;
  Pseudo: { tableId: number; secret: string };
  TableList: undefined;
  Chat: { toTableId?: number; toTableNumber?: number; contactId?: number };
};
