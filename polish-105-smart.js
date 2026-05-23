#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Smart polish for Year 105 explanations
 *
 * Rules from POLISH_SPEC.md:
 * 1. Structure: **正解：(X) ...**\n\nRationale\n\nImages\n\nReferences
 * 2. Delete stem-echo if present at start
 * 3. Preserve images byte-exact
 * 4. Never invent facts
 * 5. Keep 繁體中文 + English med terminology
 * 6. Light generation for minimal hints
 */

function extractImages(text) {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const images = [];
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    images.push(`![${match[1]}](${match[2]})`);
  }
  return images;
}

function removeImages(text) {
  return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '').trim();
}

function isReferenceLine(line) {
  // Heuristics for reference/citation lines
  return /^(Ref|PMID|doi|http|\w+\s\(\d{4}\)|^\d+\.|Leukemia|nejm|NEJM|Wintrobe|wiki)/.test(line) ||
         /Leukemia|nejm\.org|Wintrobe|\(\d{4}\)|\d+,\s\d+/.test(line);
}

function polishExplanation(question) {
  const { number, stem, options, answer, explanation_md } = question;

  if (!explanation_md || !explanation_md.trim()) {
    return '';
  }

  // Step 1: Extract and preserve images
  const images = extractImages(explanation_md);
  let workText = removeImages(explanation_md).trim();

  // Step 2: Remove answer key prefix (e.g., "D: The use of TKIs..." -> remove "D: ")
  workText = workText.replace(/^[A-E]:\s*/, '').trim();

  // Step 3: Split into lines for processing
  const lines = workText.split('\n').map(l => l.trim()).filter(l => l);

  // Step 4: Separate references from main content
  let mainLines = [];
  let refLines = [];

  for (const line of lines) {
    if (isReferenceLine(line)) {
      refLines.push(line);
    } else {
      mainLines.push(line);
    }
  }

  const mainContent = mainLines.join('\n').trim();
  const references = refLines.join('\n').trim();

  // Step 5: Get answer option text
  const answerText = options[answer] || '';
  const optionPreview = answerText.substring(0, 100).replace(/\n/g, ' ');

  // Step 6: Build polished explanation
  let polished = `**正解：(${answer}) ${optionPreview}**`;

  if (mainContent) {
    polished += '\n\n' + mainContent;
  }

  if (images.length > 0) {
    polished += '\n\n' + images.join('\n');
  }

  if (references) {
    polished += '\n\n' + references;
  }

  return polished.trim();
}

function processBatch(batchPath) {
  const batchName = path.basename(batchPath);
  const data = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));

  let changedCount = 0;
  let sampleDiff = null;

  for (let i = 0; i < data.length; i++) {
    const q = data[i];
    const oldExp = q.explanation_md || '';
    const newExp = polishExplanation(q);

    if (oldExp !== newExp) {
      changedCount++;
      if (!sampleDiff && newExp) {
        sampleDiff = {
          number: q.number,
          answer: q.answer,
          before: oldExp.substring(0, 500),
          after: newExp.substring(0, 500)
        };
      }
    }

    q.explanation_md = newExp;
  }

  // Write back with exact formatting
  const output = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(batchPath, output, 'utf-8');

  // Verify JSON
  try {
    JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
  } catch (e) {
    throw new Error(`${batchName} JSON parse failed: ${e.message}`);
  }

  return { batchName, total: data.length, changed: changedCount, sample: sampleDiff };
}

async function main() {
  const batchDir = '/Users/htlin/hema-2026/years/105/batches';
  const files = fs.readdirSync(batchDir)
    .filter(f => /^batch-\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

  let totalQuestions = 0;
  let totalChanged = 0;
  const samples = [];

  for (const file of files) {
    try {
      const result = processBatch(path.join(batchDir, file));
      totalQuestions += result.total;
      totalChanged += result.changed;
      if (result.sample) samples.push(result.sample);
      console.log(`✓ ${result.batchName}: ${result.changed}/${result.total} changed`);
    } catch (e) {
      console.error(`✗ ${file}: ${e.message}`);
      process.exit(1);
    }
  }

  console.log(`\n=== YEAR 105 POLISH COMPLETE ===`);
  console.log(`Total questions: ${totalQuestions}`);
  console.log(`Total polished: ${totalChanged}`);

  if (samples.length > 0) {
    const s = samples[0];
    console.log(`\n=== SAMPLE (Question #${s.number}, Answer: ${s.answer}) ===`);
    console.log(`\nBEFORE:\n${s.before}${s.before.length >= 500 ? '...' : ''}`);
    console.log(`\nAFTER:\n${s.after}${s.after.length >= 500 ? '...' : ''}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
