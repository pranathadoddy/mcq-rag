import fs from 'fs';
import path from 'path';
import axios from 'axios';

// Load all questions
const questions = JSON.parse(
  fs.readFileSync(
    path.join('data', '5_estate_planning_questions.json'),
    'utf-8'
  )
);

// Kumpulan soal yang salah
const wrongAnswers: any[] = [];

async function evaluateChapter(chapterKey: string) {
  const chapterQuestions = questions[chapterKey];
  let correct = 0;

  for (const q of chapterQuestions) {
    try {
      const response = await axios.post('http://localhost:4000/answer', {
        question: q.question,
        answerKey: q.answer,
        chapter: chapterKey,
      });

      const {
        predicted,
        correct: actual,
        rawAnswer,
        context,
        isCorrect,
      } = response.data;

      console.log(
        `[${chapterKey}] ${q.question
          .slice(0, 60)
          .replace(/\n/g, ' ')}... → ${predicted} (${isCorrect ? '✅' : '❌'})`
      );

      if (isCorrect) {
        correct++;
      } else {
        wrongAnswers.push({
          chapter: chapterKey,
          question: q.question,
          correctAnswer: actual,
          predictedAnswer: predicted,
          rawAnswer,
          context: context,
        });
      }
    } catch (error) {
      console.error(
        `[${chapterKey}] Failed to evaluate question: ${q.question.slice(
          0,
          30
        )}`,
        error
      );
    }
  }

  const score = ((correct / chapterQuestions.length) * 100).toFixed(2);
  console.log(`🎯 Accuracy for ${chapterKey}: ${score}%\n`);

  return { correct, total: chapterQuestions.length };
}

(async () => {
  const chapterKeys = Object.keys(questions).filter((key) =>
    key.startsWith('chapter_')
  );

  let totalCorrect = 0;
  let totalQuestions = 0;

  for (const chapterKey of chapterKeys) {
    const { correct, total } = await evaluateChapter(chapterKey);
    totalCorrect += correct;
    totalQuestions += total;
  }

  console.log('all done');
  const overall = ((totalCorrect / totalQuestions) * 100).toFixed(2);
  console.log(`✅ TOTAL CORRECT: ${totalCorrect}/${totalQuestions}`);
  console.log(`📊 OVERALL ACCURACY: ${overall}%`);

  if (wrongAnswers.length > 0) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `wrong_answers_${timestamp}.json`;
    fs.writeFileSync(
      path.join('output', filename),
      JSON.stringify(wrongAnswers, null, 2)
    );
    console.log(
      `❌ Saved ${wrongAnswers.length} wrong answers to: output/${filename}`
    );
  } else {
    console.log('🎉 No incorrect answers found.');
  }
})();
