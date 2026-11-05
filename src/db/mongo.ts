import { MongoClient, type Db } from 'mongodb';

export interface MongoHandle {
  client: MongoClient;
  db: Db;
  close(): Promise<void>;
}

export async function connectMongo(url: string, dbName: string): Promise<MongoHandle> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  return { client, db: client.db(dbName), close: () => client.close() };
}
