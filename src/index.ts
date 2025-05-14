import fs from 'fs';
import path from 'path';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { Document } from '@pinecone-database/doc-splitter';
import { getEmbeddings } from './embedding';
import { Pinecone, PineconeRecord } from '@pinecone-database/pinecone';
import md5 from 'md5';
import { convertToAscii } from './utils';
import dotenv from 'dotenv';

dotenv.config();

const LESSONS_DIR = path.join('data', '5_estate_planning', 'Lessons');
const OUTPUT_DIR = 'output';

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

export const truncateStringByBytes = (str: string, bytes: number) => {
  const enc = new TextEncoder();
  return new TextDecoder('utf-8').decode(enc.encode(str).slice(0, bytes));
};

export const getPineconeClient = () => {
  return new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
};

function extractNamespaceFromFileName(fileName: string): string {
  const match = fileName.match(/^(\d+)\./);
  if (!match) throw new Error(`Tidak bisa ekstrak namespace dari: ${fileName}`);
  return `chapter_${match[1]}`;
}

function extractHeading(text: string): string {
  const headingMatch = text.match(/^((\d+\.){1,3}|[A-Z]{1,5}\.)\s+([^\n]+)/);
  if (headingMatch) return headingMatch[0].trim();
  return text.split(/\s+/).slice(0, 6).join(' ') + '...';
}

function detectLegalMetadata(content: string): Partial<Record<string, string>> {
  const lower = content.toLowerCase();
  const metadata: Record<string, string> = {};
  if (/survivorship|operation of law|tenancy in common/.test(lower)) {
    metadata.legal_process = 'operation_of_law';
    metadata.probate_type = 'non-probate';
  }
  if (/faraid|syariah|muslim|hibah|wasiyyah/.test(lower)) {
    metadata.audience = 'muslim';
  } else if (/wills act|non-muslim|testator|executor/.test(lower)) {
    metadata.audience = 'non-muslim';
  }
  return metadata;
}

function cleanDoubleSpacedLetters(text: string): string {
  return text.replace(/([A-Za-z])(?:\s\1)+/g, '$1');
}

async function embedDocument(doc: Document): Promise<PineconeRecord> {
  const embeddings = await getEmbeddings(doc.pageContent);
  const hash = md5(doc.pageContent);
  const legalMeta = detectLegalMetadata(doc.pageContent);
  return {
    id: hash,
    values: embeddings,
    metadata: {
      pageNumber: doc.metadata.pageNumber,
      chapter: doc.metadata.chapter,
      fileName: doc.metadata.fileName,
      heading: doc.metadata.heading,
      text: truncateStringByBytes(doc.pageContent, 36000),
      ...legalMeta,
    },
  } as PineconeRecord;
}

async function prepareDocument(
  page: any,
  fileName: string
): Promise<Document[]> {
  let { pageContent, metadata } = page;
  pageContent = cleanDoubleSpacedLetters(
    pageContent.replace(/\n/g, ' ').trim()
  );
  const heading = extractHeading(pageContent);

  const splitter = new RecursiveCharacterTextSplitter();

  const baseDoc = new Document({
    pageContent,
    metadata: {
      pageNumber: metadata.loc.pageNumber,
      chapter: extractNamespaceFromFileName(fileName),
      fileName,
      heading,
      text: truncateStringByBytes(pageContent, 36000),
    },
  });

  return splitter.splitDocuments([baseDoc]);
}

async function processPdfFile(filePath: string, fileName: string) {
  const loader = new PDFLoader(filePath);
  const pages = (await loader.load()) as any[];

  const documents = await Promise.all(
    pages.map((page) => prepareDocument(page, fileName))
  );
  const vectors = await Promise.all(documents.flat().map(embedDocument));

  const client = await getPineconeClient();
  const pineconeIndex = await client.index(process.env.PINECONE_INDEX_NAME!);
  const namespaceName = extractNamespaceFromFileName(fileName);
  const namespace = pineconeIndex.namespace(convertToAscii(namespaceName));

  console.log(
    `📦 Uploading ${vectors.length} vectors to namespace: ${namespaceName}`
  );
  await namespace.upsert(vectors);
  console.log(`✅ Done uploading ${fileName}\n`);
}

async function processAllPdfs() {
  const files = fs
    .readdirSync(LESSONS_DIR)
    .filter((file) => file.endsWith('.pdf'));

  for (const file of files) {
    const fullPath = path.join(LESSONS_DIR, file);
    const fileName = path.parse(file).name;
    try {
      await processPdfFile(fullPath, fileName);
    } catch (err) {
      console.error(`❌ Gagal memproses file: ${fileName}`, err);
    }
  }
}

processAllPdfs().catch(console.error);
