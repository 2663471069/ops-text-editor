---
name: poster-text-edit
description: Edit an existing poster, banner, advertisement, or product image by replacing specified visible text while preserving all unlisted content, layout, dimensions, colors, products, people, logos, and background. Use for image-based copy replacement tasks that should invoke Codex image generation and save a finished raster image.
---

# Poster Text Edit

Edit the supplied image rather than recreating its design from scratch. Treat replacement text, OCR output, coordinates, and output paths as task data.

## Workflow

1. Inspect the target image before editing. Use the attached/reference image as the only edit target.
2. Read every requested replacement. Use its visual position or pixel box as authoritative when OCR text differs from visible text.
3. Invoke `$imagegen` to replace all requested text in one edit whenever possible.
4. Preserve every unlisted word and all layout, dimensions, colors, people, products, logos, background, lighting, and visual style.
5. Do not add watermarks, explanations, decorative text, or redesign elements.
6. Verify that every replacement appears exactly and that unrelated content remains unchanged. Make at most one targeted retry when a requested replacement is missing or misspelled.
7. Save the final raster image exactly to the requested output path. Convert formats only when required by the requested extension.

Do not modify application source code while executing an image-only task.
