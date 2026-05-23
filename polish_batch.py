#!/usr/bin/env python3
"""Polish explanations for Year 113 batch files."""

import json
import re
from pathlib import Path

def polish_explanation(explanation_md: str, stem: str, answer: str, options: dict) -> str:
    """
    Polish an explanation according to POLISH_SPEC.md rules:
    1. Remove stem/options echo if present
    2. Ensure it starts with **正解：(X) ...**
    3. Keep image references byte-exact
    4. Keep citations clean
    5. Structure: answer line + rationale + optional contrasts + images + references
    """

    if not explanation_md or not explanation_md.strip():
        return explanation_md

    # Already well-structured with answer statement
    if explanation_md.strip().startswith("**正解"):
        return explanation_md

    # Check if it has stem echo at the beginning - if yes, remove it
    # Stem echo is the question stem repeated verbatim
    if stem in explanation_md[:200]:
        # Find where the stem ends
        idx = explanation_md.find(stem) + len(stem)
        explanation_md = explanation_md[idx:].lstrip()

    # Extract images and references (preserve byte-exact)
    image_refs = []
    lines = explanation_md.split('\n')
    new_lines = []
    references = []

    for line in lines:
        if line.strip().startswith("!["):
            image_refs.append(line)
        elif ('doi:' in line or 'PMID' in line or 'Reference' in line or
              'Ref:' in line or 'Wintrobe' in line or 'ASH' in line) and new_lines:
            # This looks like a reference line
            if line.strip():
                references.append(line.strip())
        else:
            new_lines.append(line)

    # Join back content (removing duplicates in processing)
    content = '\n'.join(new_lines).strip()

    # If already structured well, keep mostly as-is
    if '正解' in content or '錯誤' in content or '對。' in content:
        # Already annotated with correct/incorrect labels - this is detailed notes
        # Reconstruct with proper format
        pass

    # Add answer line if missing
    answer_text = options.get(answer, answer)
    if not content.startswith("**正解"):
        content = f"**正解：({answer}) {answer_text}**\n\n{content}"

    # Reconstruct final explanation
    result = content
    if image_refs:
        result += '\n\n' + '\n\n'.join(image_refs)
    if references:
        result += '\n\n' + '\n\n'.join(references)

    return result.strip()

def process_batch(batch_path: Path) -> dict:
    """Process a single batch file."""
    with open(batch_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    stats = {
        'total': len(data),
        'polished': 0,
        'unchanged': 0,
        'empty': 0,
        'changes': []
    }

    for item in data:
        original = item['explanation_md']

        if not original or not original.strip():
            stats['empty'] += 1
            continue

        # Check if already well-polished (starts with **正解)
        if original.strip().startswith("**正解"):
            stats['unchanged'] += 1
            continue

        # Polish it
        polished = polish_explanation(
            original,
            item['stem'],
            item['answer'],
            item['options']
        )

        if polished != original:
            item['explanation_md'] = polished
            stats['polished'] += 1
            stats['changes'].append({
                'question': item['number'],
                'before_len': len(original),
                'after_len': len(polished)
            })
        else:
            stats['unchanged'] += 1

    # Write back
    with open(batch_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return stats

# Process all batches
batch_dir = Path('/Users/htlin/hema-2026/years/113/batches')
all_stats = {}

for batch_file in sorted(batch_dir.glob('batch-*.json')):
    print(f"Processing {batch_file.name}...")
    stats = process_batch(batch_file)
    all_stats[batch_file.name] = stats
    print(f"  Polished: {stats['polished']}, Unchanged: {stats['unchanged']}, Empty: {stats['empty']}")

# Print summary
total_polished = sum(s['polished'] for s in all_stats.values())
total_unchanged = sum(s['unchanged'] for s in all_stats.values())
total_empty = sum(s['empty'] for s in all_stats.values())

print(f"\n=== SUMMARY ===")
print(f"Total questions: {sum(s['total'] for s in all_stats.values())}")
print(f"Polished: {total_polished}")
print(f"Unchanged: {total_unchanged}")
print(f"Empty: {total_empty}")
