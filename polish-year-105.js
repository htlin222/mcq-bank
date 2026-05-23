#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Polish explanation_md field according to POLISH_SPEC.md rules:
 * 1. Delete stem-echo prefix (if explanation starts with question stem/options)
 * 2. Structure as: **正解：(X) ...**\n\nRationale\n\nOptional bullets for distractors\n\nImages (byte-exact preserved)\n\nReferences (preserved)
 * 3. Never invent: citations, PMIDs, DOIs, drug doses, lab cutoffs, gene names, percentages, mutation hotspots
 * 4. Preserve every ![alt](url) image reference byte-exact
 * 5. Keep 繁體中文 + English medical terminology
 * 6. Markdown only, supported subset
 * 7. Light generation: if source is just stem-echo with no real explanation, generate brief 2-3 sentence rationale based on hint
 */

function removeMarkdownPrefixFromExplanation(explanation, stem, options, answerKey) {
  if (!explanation) return '';

  // Very crude stem-echo detection: if explanation starts with the stem or begins with option keys
  // This is heuristic and may not catch all cases
  const optionKeys = Object.keys(options);

  // Check if explanation starts with stem
  if (explanation.toLowerCase().includes(stem.toLowerCase().substring(0, 50))) {
    // Find where the actual content starts (after options are echoed)
    let lines = explanation.split('\n');
    let startIdx = 0;

    // Look for first line that doesn't look like an option echo
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !optionKeys.some(k => line.startsWith(k + ':')) &&
          !line.startsWith(stem.substring(0, 30))) {
        startIdx = i;
        break;
      }
    }

    return lines.slice(startIdx).join('\n').trim();
  }

  return explanation.trim();
}

function extractImages(text) {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const images = [];
  let match;

  while ((match = imageRegex.exec(text)) !== null) {
    images.push(`![${match[1]}](${match[2]})`);
  }

  return images;
}

function polishExplanation(question) {
  const { stem, options, answer, explanation_md } = question;

  if (!explanation_md) {
    return '';
  }

  // Extract images first (preserve byte-exact)
  const images = extractImages(explanation_md);
  const imageLines = images.map(img => img).join('\n');

  // Remove images from working text
  let workingText = explanation_md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '').trim();

  // Remove stem-echo prefix
  workingText = removeMarkdownPrefixFromExplanation(workingText, stem, options, answer);

  // Split into sections: main content + references
  let lines = workingText.split('\n').map(l => l.trim()).filter(l => l);

  let mainContent = '';
  let references = '';

  // Heuristic: if a line mentions a journal, PMID, citation, or is clearly a reference, collect it at end
  let mainLines = [];
  let refLines = [];

  for (const line of lines) {
    if (line.match(/^(ref|reference|source|citation|\d+\.|PMID|doi|http|\w+\s\(\d{4}\)|\w+.*j\s(med|j|plos))/i) ||
        line.includes('nejm.org') || line.includes('Leukemia') || line.includes('Wintrobe') ||
        line.match(/^\d+/)) {
      refLines.push(line);
    } else {
      mainLines.push(line);
    }
  }

  mainContent = mainLines.join('\n').trim();
  references = refLines.join('\n').trim();

  // Build polished version
  const answerLabel = `**正解：(${answer})`; // Will add option text or short paraphrase

  // Try to extract the correct option text
  const optionText = options[answer] || answer;
  const optionPreview = optionText.substring(0, 80).replace(/\n/g, ' ').trim();

  let polished = `**正解：(${answer}) ${optionPreview}**`;

  if (mainContent) {
    // Light formatting: if mainContent is very short (just a hint), keep it simple
    polished += '\n\n' + mainContent;
  }

  // Add images back
  if (imageLines) {
    polished += '\n\n' + imageLines;
  }

  // Add references if present
  if (references) {
    polished += '\n\n' + references;
  }

  return polished.trim();
}

function processBatch(batchPath) {
  console.log(`Processing ${path.basename(batchPath)}...`);

  let data = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
  let changeCount = 0;
  const samples = [];

  for (let i = 0; i < data.length; i++) {
    const question = data[i];
    const oldExplanation = question.explanation_md;

    const newExplanation = polishExplanation(question);

    // Track if meaningful change occurred
    if (oldExplanation !== newExplanation) {
      changeCount++;
      if (samples.length < 1) {
        samples.push({
          number: question.number,
          old: oldExplanation,
          new: newExplanation
        });
      }
    }

    question.explanation_md = newExplanation;
  }

  // Write back
  fs.writeFileSync(batchPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');

  // Verify JSON validity
  try {
    JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
    console.log(`  ✓ ${data.length} questions, ${changeCount} polished, JSON valid`);
  } catch (e) {
    console.error(`  ✗ JSON parse error: ${e.message}`);
    process.exit(1);
  }

  return { batchPath, total: data.length, changed: changeCount, samples };
}

async function main() {
  const batchDir = '/Users/htlin/hema-2026/years/105/batches';
  const batchFiles = fs.readdirSync(batchDir)
    .filter(f => f.match(/^batch-\d+\.json$/))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)[0]);
      const numB = parseInt(b.match(/\d+/)[0]);
      return numA - numB;
    });

  let totalQuestions = 0;
  let totalChanged = 0;
  let firstSample = null;

  for (const file of batchFiles) {
    const result = processBatch(path.join(batchDir, file));
    totalQuestions += result.total;
    totalChanged += result.changed;

    if (result.samples.length > 0 && !firstSample) {
      firstSample = result.samples[0];
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total questions polished: ${totalQuestions}`);
  console.log(`Total changes: ${totalChanged}`);

  if (firstSample) {
    console.log('\n=== SAMPLE BEFORE/AFTER ===');
    console.log(`Question #${firstSample.number}:`);
    console.log('\nBEFORE:');
    console.log(firstSample.old);
    console.log('\nAFTER:');
    console.log(firstSample.new);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
