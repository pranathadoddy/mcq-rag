import express from 'express';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAi from 'openai';
import dotenv from 'dotenv';
import { ChatCompletionMessageParam } from 'openai/resources/chat';
import { convertToAscii } from './utils';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
app.use(express.json());

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const index = pinecone.Index(process.env.PINECONE_INDEX_NAME!);
const openai = new OpenAi({ apiKey: process.env.OPENAI_API_KEY! });

// Detect chapter context to adjust retrieval parameters
function detectChapterContext(
  question: string
): 'insurance' | 'business' | 'general' {
  const lowerQuestion = question.toLowerCase();

  // Basic pattern matching for chapter 7 and 8 topics
  if (
    /life insurance|policy|nominee|beneficiary|statutory trust|assignment/.test(
      lowerQuestion
    )
  ) {
    return 'insurance';
  }
  if (
    /sole proprietor|partnership|company|shareholder|business owner|buy-sell|key person/.test(
      lowerQuestion
    )
  ) {
    return 'business';
  }

  return 'general';
}

// Original embedding function with minimal enhancement
async function getEmbedding(text: string, enhanceRetrieval: boolean = false) {
  const cleanText = text.replace(/\n/g, ' ');

  // Simple query expansion for better retrieval without using GPT
  let queryToEmbed = cleanText;

  if (enhanceRetrieval) {
    // Add basic synonyms for key terms to improve retrieval
    const chapterContext = detectChapterContext(cleanText);

    if (chapterContext === 'insurance') {
      // Simple synonym expansion for insurance queries
      if (cleanText.includes('nominee'))
        queryToEmbed += ' beneficiary executor trustee';
      if (cleanText.includes('trust'))
        queryToEmbed += ' statutory policy protection creditor';
      if (cleanText.includes('assignment'))
        queryToEmbed += ' transfer ownership assignor assignee';
    } else if (chapterContext === 'business') {
      // Simple synonym expansion for business queries
      if (cleanText.includes('sole proprietor'))
        queryToEmbed += ' individual unlimited liability';
      if (cleanText.includes('partnership'))
        queryToEmbed += ' partners joint several liability';
      if (cleanText.includes('company'))
        queryToEmbed += ' shareholder limited liability separate entity';
    }
  }

  const res = await openai.embeddings.create({
    model: 'text-embedding-ada-002',
    input: queryToEmbed,
  });
  return res.data[0].embedding!;
}

// Improved negative logic detection
function containsNegativeLogic(question: string): boolean {
  const lower = question.toLowerCase();
  return (
    lower.includes('not correct') ||
    lower.includes('is not correct') ||
    lower.includes('are not correct') ||
    lower.includes('except') ||
    lower.includes('which of the following is not') ||
    lower.includes('incorrect') ||
    lower.includes('not true') ||
    lower.includes('no longer') ||
    lower.includes('not relevant') ||
    /which .*is.* not/i.test(lower) ||
    /which .*are.* not/i.test(lower)
  );
}

function detectMultipleStatements(question: string): boolean {
  // Check for common patterns in multiple statement questions
  const hasRomanNumerals = /\b[I]{1,3}\.|\b[I]{1,3}\)|\b[I]{1,4}\b[.)]/i.test(
    question
  );

  // Check for specific patterns like "I. Statement" or "I) Statement" or just "I "
  const hasNumberedStatements =
    /\bI\s*[.)].*\bII\s*[.)]/.test(question) || // Has at least I and II
    /\bI\b.*\bII\b.*\bIII\b/.test(question); // Has I, II, III without necessarily punctuation

  // Sometimes questions list statements and then ask which are correct/incorrect
  const hasStatementsList =
    /which (?:of the following |)(?:statement|statements)(?:\(s\)|s | )(?:is|are) (?:correct|true|false|not correct|incorrect)/i.test(
      question
    ) && /\b[I]{1,4}\b/.test(question);

  return hasRomanNumerals || hasNumberedStatements || hasStatementsList;
}

// "All of the above" option detection
function hasAllOfAboveOption(options: any[]): boolean {
  return options.some((opt) => {
    const text = opt.text.toLowerCase();
    return (
      text.includes('all of the above') ||
      text.includes('all the above') ||
      text.includes('all are correct') ||
      text === 'all of these'
    );
  });
}

function extractOptions(question: string) {
  const optionsRegex = /([A-D])\.\s*(.*?)(?=\s*[A-D]\.|$)/gs;
  const matches = [...question.matchAll(optionsRegex)];
  return matches.map((match) => ({
    letter: match[1],
    text: match[2].trim(),
  }));
}

function extractStatements(question: string) {
  // Find the section with the statements (often after the main question and before options A, B, C, D)
  const statementSection = question.match(/I\..*?(?=A\.|$)/s)?.[0] || question;

  // Split by Roman numerals
  const statementMatches = statementSection.match(
    /\b[I]{1,4}\b[.)]\s*[^IVX]*/g
  );

  if (!statementMatches) return [];

  return statementMatches.map((match) => {
    // Clean up the match to just get the statement content
    return match.replace(/^\s*\b[I]{1,4}\b[.)]\s*/, '').trim();
  });
}

app.post('/answer', async (req, res) => {
  const { question: rawQuestion, chapter, answerKey } = req.body;

  try {
    const chapterContext = detectChapterContext(rawQuestion);

    const questionEmbedding = await getEmbedding(rawQuestion, true);

    const namespace = index.namespace(convertToAscii(chapter));

    const hasMultipleStatements = detectMultipleStatements(rawQuestion);
    const baseTopK = hasMultipleStatements ? 15 : 10;
    const topK = chapterContext !== 'general' ? baseTopK + 5 : baseTopK;

    const result = await namespace.query({
      vector: questionEmbedding,
      topK: topK,
      includeMetadata: true,
    });

    const qualifyingDocs = result.matches;
    type Metadata = { text: string; pageNumber: number };
    const docs = qualifyingDocs.map(
      (match) => (match.metadata as Metadata).text
    );
    const context = docs.join('\n').substring(0, 128000);

    const isNegative = containsNegativeLogic(rawQuestion);
    const statements = hasMultipleStatements
      ? extractStatements(rawQuestion)
      : [];
    const options = extractOptions(rawQuestion);
    const hasAllOfAbove = hasAllOfAboveOption(options);
    let rawAnswer = '';

    const systemPrompt = [
      'Your task is to select the most complete correct answer to a multiple-choice question based ONLY on the provided context.',

      'CRITICAL INSTRUCTIONS:',
      '1. Read the question carefully - pay special attention to negative wording like "not," "except," "false," "incorrect".',
      '2. Analyze EACH statement or option individually against the context.',
      '3. For questions with statements labeled I, II, III, etc., evaluate each statement separately before considering combinations.',
      '4. Only use information explicitly stated or directly implied in the context - never use external knowledge.',
      '5. Choose the most complete correct answer after evaluating all options.',

      hasAllOfAbove
        ? 'For "All of the above" options, verify all statements carefully before selecting this option.'
        : '',

      isNegative
        ? '⚠️ This question uses negative logic asking for what is NOT correct. Identify which statements are FALSE or which option contradicts the context.'
        : '',

      'You MUST answer with ONLY a single uppercase letter (A, B, C, or D) - no explanation or reasoning.',
    ]
      .filter(Boolean)
      .join('\n');

    let userContent = `${
      isNegative
        ? '⚠️ This question uses negative logic asking for what is NOT correct. Identify which statements are FALSE or which option contradicts the context.\n\n'
        : ''
    }`;

    userContent += `Context:\n${context}\n\nQuestion:\n${rawQuestion}\n\n`;

    if (hasAllOfAbove) {
      userContent += `Note: One of the options is "All of the above" or similar. Verify all statements carefully before selecting this option.\n\n`;
    }

    userContent += `Step 1: Identify the key question and type of logic required.
Step 2: Evaluate each statement or option individually:
${
  hasMultipleStatements
    ? statements
        .map((statement, idx) => {
          const romanNumeral = ['I', 'II', 'III', 'IV'][idx];
          return `- Statement ${romanNumeral}: "${statement}"\n  [Quote relevant context]\n  Therefore, Statement ${romanNumeral} is [TRUE/FALSE]`;
        })
        .join('\n\n')
    : options
        .map(
          (opt) =>
            `- Option ${opt.letter}: "${opt.text}"\n  [Quote relevant context]\n  Therefore, Option ${opt.letter} is [CORRECT/INCORRECT]`
        )
        .join('\n\n')
}

Step 3: Determine the correct answer based on the evaluation above.
${
  hasMultipleStatements
    ? `- Which statements are ${isNegative ? 'FALSE' : 'TRUE'}? List them.
- Which answer option correctly matches these ${
        isNegative ? 'FALSE' : 'TRUE'
      } statements?`
    : ''
}

Step 4: Verify your answer:
- Double-check that your selected option matches the question's logic (${
      isNegative ? 'what is NOT correct' : 'what IS correct'
    }).

IMPORTANT: Your final answer MUST be ONLY a single letter A, B, C, or D without any explanation.

Your final answer: `;

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    let predicted;
    const isVeryComplexQuestion =
      hasMultipleStatements && hasAllOfAbove && isNegative;

    if (isVeryComplexQuestion) {
      const analysisResponse = await openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `${userContent}\n\nPlease show your reasoning step by step, and then provide your final answer.`,
          },
        ],
        temperature: 0.2,
      });

      const analysis =
        analysisResponse.choices[0].message?.content?.trim() || '';

      console.log('Analysis:', analysis);

      const preliminaryAnswer =
        analysis.match(/Your final answer: ([A-D])/i)?.[1] || '';

      const verificationPrompt = `
I've analyzed this question in detail. My analysis points to answer ${
        preliminaryAnswer || '?'
      }.

Question: "${rawQuestion}"

Based on the analysis, what is the final answer (ONLY a single letter A, B, C, or D)?
`;

      const verificationResponse = await openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [
          {
            role: 'system',
            content:
              'You are a verification system that provides a single letter answer.',
          },
          { role: 'user', content: verificationPrompt },
        ],
        temperature: 0,
        max_tokens: 5,
      });

      rawAnswer =
        verificationResponse.choices[0].message?.content?.trim() || '';

      // Extract the answer
      if (/^[ABCD]$/.test(rawAnswer)) {
        predicted = rawAnswer;
      } else if (/^[ABCD][.:\s]/.test(rawAnswer)) {
        predicted = rawAnswer.charAt(0);
      } else {
        predicted = rawAnswer.match(/[ABCD]/)?.[0] || preliminaryAnswer || 'X';
      }
    } else {
      // Standard approach for most questions
      const response = await openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages,
        temperature: 0,
        max_tokens: 10,
      });

      // Extract only the letter answer
      rawAnswer = response.choices[0].message?.content?.trim() || '';

      // Try different patterns to extract just the letter
      if (/^[ABCD]$/.test(rawAnswer)) {
        // If it's just a single letter
        predicted = rawAnswer;
      } else if (/^[ABCD][.:\s]/.test(rawAnswer)) {
        // If it starts with a letter followed by punctuation
        predicted = rawAnswer.charAt(0);
      } else {
        // Otherwise, find the first A, B, C, or D in the response
        predicted = rawAnswer.match(/[ABCD]/)?.[0] || 'X';
      }
    }

    const isCorrect = predicted === answerKey;

    res.json({
      predicted,
      correct: answerKey,
      context,
      chapterContext,
      hasMultipleStatements,
      hasAllOfAbove,
      isNegative,
      isCorrect,
      rawAnswer,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(4000, () => {
  console.log('🚀 RAG API listening at http://localhost:4000');
});
