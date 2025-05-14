import dotenv from 'dotenv';
import { Pinecone } from '@pinecone-database/pinecone';

dotenv.config();

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

async function deleteAllNamespaces() {
  try {
    const index = pinecone.Index(process.env.PINECONE_INDEX_NAME!);
    const stats = await index.describeIndexStats();
    console.log('Index stats:', stats);

    const namespaces = Object.keys(stats.namespaces || {});
    if (namespaces.length === 0) {
      console.log('No namespaces found.');
      return;
    }

    console.log(`Found ${namespaces.length} namespaces:`);

    for (const ns of namespaces) {
      console.log(`Deleting namespace: ${ns}`);
      await index.deleteNamespace(ns);
    }

    console.log('All namespaces deleted.');
  } catch (error) {
    console.error('Error deleting namespaces:', error);
  }
}

deleteAllNamespaces();
